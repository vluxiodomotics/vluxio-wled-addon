import { EventEmitter } from "node:events";
import WebSocket, { RawData } from "ws";
import { requestJson } from "./httpJson";
import { discoverWledControllers, sameMac } from "./discovery";
import {
  extractWledState,
  parsePresets,
  WledInfo,
  WledSnapshot,
  WledState,
} from "./types";

interface WriteRequest {
  body: Record<string, unknown>;
  resolve: Array<(state: WledState) => void>;
  reject: Array<(error: Error) => void>;
}

interface PendingWrite extends WriteRequest {
  timer: NodeJS.Timeout;
}

export interface WledClientOptions {
  ipAddress: string;
  pollIntervalMs: number;
  requestTimeoutMs?: number;
  commandDebounceMs?: number;
  binaryCommandDebounceMs?: number;
  brightnessCommandDebounceMs?: number;
  enableWebSocket?: boolean;
  autoDiscovery?: boolean;
  rediscoveryIntervalMs?: number;
  expectedMac?: string;
}

export class WledClient extends EventEmitter {
  private baseUrl: URL;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly binaryCommandDebounceMs: number;
  private readonly brightnessCommandDebounceMs: number;
  private readonly enableWebSocket: boolean;
  private readonly autoDiscovery: boolean;
  private readonly rediscoveryIntervalMs: number;
  private expectedMac?: string;
  private lastRediscoveryAt = 0;
  private rediscoveryInFlight?: Promise<boolean>;
  private webSocket?: WebSocket;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private stopped = true;
  private refreshInFlight?: Promise<WledState>;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Map<string, PendingWrite>();
  private brightnessWriteInFlight = false;
  private queuedBrightnessWrite?: WriteRequest;
  private consecutiveFailures = 0;
  private online = false;
  private lastState?: WledState;

  public constructor(options: WledClientOptions) {
    super();
    this.baseUrl = normalizeBaseUrl(options.ipAddress);
    this.pollIntervalMs = Math.max(5_000, options.pollIntervalMs);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.binaryCommandDebounceMs =
      options.binaryCommandDebounceMs ?? options.commandDebounceMs ?? 15;
    this.brightnessCommandDebounceMs =
      options.brightnessCommandDebounceMs ?? options.commandDebounceMs ?? 40;
    this.enableWebSocket = options.enableWebSocket ?? true;
    this.autoDiscovery = options.autoDiscovery ?? true;
    this.rediscoveryIntervalMs = Math.max(
      60_000,
      options.rediscoveryIntervalMs ?? 180_000,
    );
    this.expectedMac = options.expectedMac;
  }

  public async start(): Promise<WledSnapshot> {
    this.stopped = false;

    let info: WledInfo;
    let state: WledState;
    let presets;
    try {
      [info, state, presets] = await Promise.all([
        this.getInfo(),
        this.refreshState(),
        this.getPresets(),
      ]);
    } catch (error) {
      if (!(await this.rediscoverController(true))) {
        throw error;
      }
      [info, state, presets] = await Promise.all([
        this.getInfo(),
        this.refreshState(),
        this.getPresets(),
      ]);
    }

    if (info.mac) {
      this.expectedMac = info.mac;
    }

    if (this.enableWebSocket) {
      this.connectWebSocket();
    }

    this.pollTimer = setInterval(() => {
      void this.refreshState().catch(() => undefined);
    }, this.pollIntervalMs);

    return { info, state, presets };
  }

  public stop(): void {
    this.stopped = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    for (const pending of this.pendingWrites.values()) {
      clearTimeout(pending.timer);
      const error = new Error("WLED client stopped");
      pending.reject.forEach((reject) => reject(error));
    }
    this.pendingWrites.clear();
    if (this.queuedBrightnessWrite) {
      const error = new Error("WLED client stopped");
      this.queuedBrightnessWrite.reject.forEach((reject) => reject(error));
      this.queuedBrightnessWrite = undefined;
    }

    if (this.webSocket) {
      this.webSocket.removeAllListeners();
      this.webSocket.close();
      this.webSocket = undefined;
    }
  }

  public async getInfo(): Promise<WledInfo> {
    const info = await requestJson<WledInfo>(this.baseUrl, "/json/info", {
      timeoutMs: this.requestTimeoutMs,
    });
    this.registerSuccess();
    if (info.mac) {
      this.expectedMac = info.mac;
    }
    return info;
  }

  public async getPresets() {
    const rawPresets = await requestJson<unknown>(
      this.baseUrl,
      "/presets.json",
      { timeoutMs: this.requestTimeoutMs },
    );
    this.registerSuccess();
    return parsePresets(rawPresets);
  }

  public refreshState(): Promise<WledState> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = requestJson<unknown>(
      this.baseUrl,
      "/json/state",
      { timeoutMs: this.requestTimeoutMs },
    )
      .then((response) => {
        const state = extractWledState(response);
        if (!state) {
          throw new Error("WLED state response has an unexpected shape");
        }
        this.acceptState(state);
        // A full GET is authoritative for the segment list. Transient POST
        // acknowledgements and connection failures are not.
        this.emit("segments", state.seg);
        return state;
      })
      .catch((error: unknown) => {
        this.registerFailure(error);
        throw error;
      })
      .finally(() => {
        this.refreshInFlight = undefined;
      });

    return this.refreshInFlight;
  }

  public setMasterOn(isOn: boolean): Promise<WledState> {
    this.supersedeBrightnessWrites();
    return this.scheduleWrite(
      "master",
      { on: isOn, v: true },
      this.binaryCommandDebounceMs,
    );
  }

  public setSegmentOn(segmentId: number, isOn: boolean): Promise<WledState> {
    const body: Record<string, unknown> = {
      seg: [{ id: segmentId, on: isOn }],
      v: true,
    };

    if (isOn) {
      body.on = true;
    }

    return this.scheduleWrite(
      `segment-${segmentId}`,
      body,
      this.binaryCommandDebounceMs,
    );
  }

  public applyPreset(presetId: number): Promise<WledState> {
    this.supersedeBrightnessWrites();
    return this.scheduleWrite(
      "preset",
      { ps: presetId, v: true },
      this.binaryCommandDebounceMs,
    );
  }

  public setBrightnessPercent(
    percentage: number,
    transitionDeciseconds?: number,
  ): Promise<WledState> {
    const normalized = clampPercentage(percentage);
    const body: Record<string, unknown> =
      normalized === 0
        ? { on: false, v: true }
        : {
            on: true,
            bri: brightnessPercentToByte(normalized),
            v: true,
          };
    if (transitionDeciseconds !== undefined) {
      body.tt = normalizeTransition(transitionDeciseconds);
    }

    return this.scheduleWrite(
      "brightness",
      body,
      this.brightnessCommandDebounceMs,
    );
  }

  public getLastState(): WledState | undefined {
    return this.lastState;
  }

  private scheduleWrite(
    key: string,
    body: Record<string, unknown>,
    debounceMs: number,
  ): Promise<WledState> {
    if (this.stopped) {
      return Promise.reject(new Error("WLED client is not running"));
    }

    return new Promise<WledState>((resolve, reject) => {
      const existing = this.pendingWrites.get(key);
      if (existing) {
        existing.body = body;
        existing.resolve.push(resolve);
        existing.reject.push(reject);
        return;
      }

      const pending: PendingWrite = {
        body,
        resolve: [resolve],
        reject: [reject],
        timer: setTimeout(() => {
          this.pendingWrites.delete(key);
          if (key === "brightness") {
            this.enqueueLatestBrightness(pending);
            return;
          }
          this.dispatchWrite(pending);
        }, debounceMs),
      };

      this.pendingWrites.set(key, pending);
    });
  }

  private enqueueLatestBrightness(request: WriteRequest): void {
    if (this.brightnessWriteInFlight) {
      if (this.queuedBrightnessWrite) {
        this.queuedBrightnessWrite.body = request.body;
        this.queuedBrightnessWrite.resolve.push(...request.resolve);
        this.queuedBrightnessWrite.reject.push(...request.reject);
      } else {
        this.queuedBrightnessWrite = {
          body: request.body,
          resolve: [...request.resolve],
          reject: [...request.reject],
        };
      }
      return;
    }

    this.brightnessWriteInFlight = true;
    void this.enqueuePost(request.body)
      .then((state) => {
        request.resolve.forEach((resolver) => resolver(state));
      })
      .catch((error: unknown) => {
        const normalizedError = toError(error);
        request.reject.forEach((rejecter) => rejecter(normalizedError));
      })
      .finally(() => {
        this.brightnessWriteInFlight = false;
        const next = this.queuedBrightnessWrite;
        this.queuedBrightnessWrite = undefined;
        if (next) {
          if (this.stopped) {
            const error = new Error("WLED client stopped");
            next.reject.forEach((reject) => reject(error));
          } else {
            this.enqueueLatestBrightness(next);
          }
        }
      });
  }

  private dispatchWrite(request: WriteRequest): void {
    void this.enqueuePost(request.body)
      .then((state) => {
        request.resolve.forEach((resolver) => resolver(state));
      })
      .catch((error: unknown) => {
        const normalizedError = toError(error);
        request.reject.forEach((rejecter) => rejecter(normalizedError));
      });
  }

  private supersedeBrightnessWrites(): void {
    const pending = this.pendingWrites.get("brightness");
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingWrites.delete("brightness");
      this.resolveSupersededWrite(pending);
    }
    if (this.queuedBrightnessWrite) {
      this.resolveSupersededWrite(this.queuedBrightnessWrite);
      this.queuedBrightnessWrite = undefined;
    }
  }

  private resolveSupersededWrite(request: WriteRequest): void {
    if (this.lastState) {
      request.resolve.forEach((resolver) => resolver(this.lastState!));
      return;
    }

    const error = new Error("Brightness command superseded");
    request.reject.forEach((rejecter) => rejecter(error));
  }

  private enqueuePost(body: Record<string, unknown>): Promise<WledState> {
    const result = this.writeChain.then(() => this.postState(body));
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async postState(
    body: Record<string, unknown>,
  ): Promise<WledState> {
    try {
      const response = await requestJson<unknown>(
        this.baseUrl,
        "/json/state",
        {
          method: "POST",
          body,
          timeoutMs: this.requestTimeoutMs,
        },
      );
      const returnedState = extractWledState(response);
      if (returnedState) {
        // WLED can acknowledge a preset POST with the previous preset while
        // the new preset is already active. Read back the current preset so
        // the next button press does not navigate from stale state.
        if (typeof body.ps === "number" && returnedState.ps !== body.ps) {
          return await this.refreshState();
        }
        this.acceptState(returnedState);
        return returnedState;
      }

      return await this.refreshState();
    } catch (error) {
      this.registerFailure(error);
      throw error;
    }
  }

  private connectWebSocket(): void {
    if (this.stopped || this.webSocket) {
      return;
    }

    const webSocketUrl = new URL("/ws", this.baseUrl);
    webSocketUrl.protocol = this.baseUrl.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(webSocketUrl, {
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: this.requestTimeoutMs,
    });
    this.webSocket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.registerSuccess();
      void this.refreshState().catch((error: unknown) => {
        this.emit("diagnostic", toError(error));
      });
    });

    socket.on("message", (data: RawData) => {
      this.handleWebSocketMessage(data);
    });

    socket.on("error", (error: Error) => {
      this.emit("diagnostic", error);
    });

    socket.on("close", () => {
      if (this.webSocket === socket) {
        this.webSocket = undefined;
      }
      this.scheduleReconnect();
    });
  }

  private handleWebSocketMessage(data: RawData): void {
    if (Array.isArray(data)) {
      return;
    }

    try {
      const text =
        typeof data === "string"
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data)).toString("utf8")
            : data.toString("utf8");
      const payload = JSON.parse(text) as unknown;
      const state = extractWledState(payload);
      if (state) {
        this.acceptState(state);
      }
    } catch (error) {
      this.emit("diagnostic", toError(error));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    const baseDelay = Math.min(
      30_000,
      1_000 * Math.pow(2, this.reconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWebSocket();
    }, baseDelay + jitter);
  }

  private acceptState(state: WledState): void {
    this.lastState = state;
    this.registerSuccess();
    this.emit("state", state);
  }

  private registerSuccess(): void {
    this.consecutiveFailures = 0;
    if (!this.online) {
      this.online = true;
      this.emit("online", true);
    }
  }

  private registerFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.emit("diagnostic", toError(error));
    if (this.online && this.consecutiveFailures >= 2) {
      this.online = false;
      this.emit("online", false);
    }
    if (this.consecutiveFailures >= 3) {
      void this.rediscoverController(false).then((changed) => {
        if (!changed || this.stopped) {
          return;
        }
        void this.refreshState().catch((refreshError: unknown) => {
          this.emit("diagnostic", toError(refreshError));
        });
        if (this.enableWebSocket) {
          if (this.webSocket) {
            this.webSocket.removeAllListeners();
            this.webSocket.close();
            this.webSocket = undefined;
          }
          this.connectWebSocket();
        }
      });
    }
  }

  private rediscoverController(force: boolean): Promise<boolean> {
    if (!this.autoDiscovery || this.stopped) {
      return Promise.resolve(false);
    }

    const now = Date.now();
    if (!force && now - this.lastRediscoveryAt < this.rediscoveryIntervalMs) {
      return Promise.resolve(false);
    }
    if (this.rediscoveryInFlight) {
      return this.rediscoveryInFlight;
    }

    this.lastRediscoveryAt = now;
    this.rediscoveryInFlight = discoverWledControllers({
      expectedMac: this.expectedMac,
      timeoutMs: 3_000,
      requestTimeoutMs: Math.min(this.requestTimeoutMs, 2_000),
    })
      .then((controllers) => {
        const candidates = this.expectedMac
          ? controllers.filter((controller) =>
              sameMac(controller.info.mac, this.expectedMac),
            )
          : controllers;
        if (candidates.length !== 1) {
          if (candidates.length > 1) {
            this.emit(
              "diagnostic",
              new Error(
                "Multiple WLED controllers found; set a fixed IP or MAC address",
              ),
            );
          }
          return false;
        }

        const candidate = candidates[0];
        if (candidate.info.mac) {
          this.expectedMac = candidate.info.mac;
        }
        if (candidate.baseUrl.href === this.baseUrl.href) {
          return false;
        }

        this.baseUrl = candidate.baseUrl;
        this.reconnectAttempt = 0;
        this.emit(
          "diagnostic",
          new Error(`WLED rediscovered at ${this.baseUrl.hostname}`),
        );
        return true;
      })
      .catch((discoveryError: unknown) => {
        this.emit("diagnostic", toError(discoveryError));
        return false;
      })
      .finally(() => {
        this.rediscoveryInFlight = undefined;
      });

    return this.rediscoveryInFlight;
  }
}

function normalizeBaseUrl(ipAddress: string): URL {
  const trimmed = ipAddress.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function brightnessPercentToByte(percentage: number): number {
  const normalized = clampPercentage(percentage);
  if (normalized === 0) {
    return 0;
  }
  return Math.max(1, Math.round((normalized * 255) / 100));
}

export function brightnessByteToPercent(value: number): number {
  const normalized = Math.max(0, Math.min(255, Math.round(value)));
  return Math.round((normalized * 100) / 255);
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function normalizeTransition(value: number): number {
  if (!Number.isFinite(value)) {
    return 15;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}
