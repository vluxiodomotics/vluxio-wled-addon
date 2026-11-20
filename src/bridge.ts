import {
  FreeAtHome,
  FreeAtHomeOnOffChannel,
} from "@busch-jaeger/free-at-home";
import { WledAddonConfig } from "./config";
import { ResponsiveDimmerChannel } from "./freeAtHome/ResponsiveDimmerChannel";
import {
  brightnessByteToPercent,
  WledClient,
} from "./wled/WledClient";
import { WledInfo, WledPreset, WledSegment, WledSnapshot, WledState } from "./wled/types";

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class WledFreeAtHomeBridge {
  private masterChannel?: ResponsiveDimmerChannel;
  private readonly segmentChannels = new Map<
    number,
    FreeAtHomeOnOffChannel
  >();
  private readonly presetChannels = new Map<
    number,
    FreeAtHomeOnOffChannel
  >();
  private readonly availablePresets: WledPreset[] = [];
  private readonly allChannels: ManagedChannel[] = [];
  private readonly pulseTimers = new Map<string, NodeJS.Timeout>();
  private presetModeExitTimer?: NodeJS.Timeout;
  private presetModeActive = false;
  private readonly recentOnPresses: number[] = [];
  private lastState?: WledState;
  private segmentQueue: Promise<void> = Promise.resolve();
  private stopping = false;
  private stableControllerId?: string;

  private readonly segmentsListener = (segments: WledSegment[]) => {
    this.segmentQueue = this.segmentQueue.then(() => this.reconcileSegments(segments))
      .catch((error: unknown) => this.logger.warn(`Segment update failed: ${String(error)}`));
  };

  private readonly stateListener = (state: WledState) => {
    this.syncState(state);
  };
  private readonly onlineListener = (online: boolean) => {
    void this.updateReachability(online);
  };
  private readonly diagnosticListener = (error: Error) => {
    this.logger.warn(`WLED: ${error.message}`);
  };

  public constructor(
    private readonly freeAtHome: FreeAtHome,
    private readonly wled: WledClient,
    private readonly config: WledAddonConfig,
    private readonly logger: Logger = console,
    private readonly presetModeIdleMs = 5_000,
  ) {}

  public async start(): Promise<void> {
    this.stopping = false;
    const snapshot = await this.wled.start();
    const devicePlan = buildVirtualDevicePlan(snapshot, this.config);
    this.stableControllerId = createStableId(snapshot.info, this.config.wledIp);

    this.wled.on("state", this.stateListener);
    this.wled.on("online", this.onlineListener);
    this.wled.on("diagnostic", this.diagnosticListener);
    this.wled.on("segments", this.segmentsListener);

    this.masterChannel = await this.createDimmerChannel(
      devicePlan.master.nativeId,
      devicePlan.master.name,
    );
    this.masterChannel.on("isOnChanged", (isOn: boolean) => {
      if (this.presetModeActive) {
        this.clearPresetModeExitTimer();
        void this.activateAdjacentPreset(isOn ? 1 : -1).finally(() => {
          this.schedulePresetModeExit();
        });
        return;
      }
      if (isOn && this.recordPresetActivationPress()) return;
      void this.handleMasterCommand(isOn);
    });
    this.masterChannel.on(
      "absoluteValueChanged",
      (percentage: number, source: "absolute" | "relative") => {
        void this.handleBrightnessCommand(percentage, source);
      },
    );
    this.masterChannel.on("relativePressStarted", (direction: 1 | -1) => {
      if (this.presetModeActive) {
        this.clearPresetModeExitTimer();
        void this.activateAdjacentPreset(direction);
        return;
      }
    });
    this.masterChannel.on("relativePressStopped", () => {
      if (this.presetModeActive) {
        this.schedulePresetModeExit();
      }
    });
    this.masterChannel.on("relativeStepRequested", (direction: 1 | -1) => {
      if (!this.presetModeActive) {
        return;
      }
      this.clearPresetModeExitTimer();
      void this.activateAdjacentPreset(direction).finally(() => {
        this.schedulePresetModeExit();
      });
    });

    for (const segment of devicePlan.segments) {
      const channel = await this.createChannel(
        segment.nativeId,
        segment.name,
      );
      channel.on("isOnChanged", (isOn: boolean) => {
        void this.handleSegmentCommand(channel, segment.segmentId, isOn);
      });
      this.segmentChannels.set(segment.segmentId, channel);
    }

    for (const preset of devicePlan.presets) {
      this.availablePresets.push(preset.preset);
      await this.createPresetChannel(preset);
    }

    for (const navigation of devicePlan.navigation) {
      await this.createPresetNavigationChannel(navigation);
    }

    this.syncState(snapshot.state);
    this.logger.info(
      `WLED ${snapshot.info.product ?? ""} ${snapshot.info.ver}: ` +
        `${this.segmentChannels.size} segments and ` +
        `${this.presetChannels.size} presets connected`,
    );
  }

  public async stop(options: StopOptions = {}): Promise<void> {
    this.stopping = true;
    this.wled.off("segments", this.segmentsListener);
    await this.segmentQueue;
    this.wled.off("state", this.stateListener);
    this.wled.off("online", this.onlineListener);
    this.wled.off("diagnostic", this.diagnosticListener);
    this.wled.stop();
    this.masterChannel?.dispose();
    this.recentOnPresses.length = 0;
    this.exitPresetMode();

    for (const timer of this.pulseTimers.values()) {
      clearTimeout(timer);
    }
    this.pulseTimers.clear();

    const results = await Promise.allSettled(
      this.allChannels.map(async (channel) => {
        channel.setAutoKeepAlive(false);
        if (options.removeVirtualDevices) {
          await channel.destroy();
          return;
        }
        await channel.setUnresponsive();
      }),
    );

    if (options.removeVirtualDevices) {
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        this.logger.warn(
          `${failed.length} virtual WLED device(s) could not be removed`,
        );
      } else {
        this.logger.info("Virtual WLED devices removed from free@home");
      }
    }
  }

  private async reconcileSegments(segments: WledSegment[]): Promise<void> {
    if (this.stopping) return;
    const current = new Map(segments.map((segment) => [segment.id, segment]));
    const stableId = this.stableControllerId ?? createStableId({ ver: "" }, this.config.wledIp);
    for (const segment of segments) {
      if (this.segmentChannels.has(segment.id)) continue;
      const channel = await this.createChannel(
        `wled-${stableId}-segment-${segment.id}`,
        this.config.segmentNames.get(segment.id) ?? segment.name?.trim() ?? `WLED segment ${segment.id + 1}`,
      );
      channel.on("isOnChanged", (isOn: boolean) => {
        void this.handleSegmentCommand(channel, segment.id, isOn);
      });
      this.segmentChannels.set(segment.id, channel);
    }
    for (const [id, channel] of this.segmentChannels) {
      if (current.has(id)) continue;
      channel.setAutoKeepAlive(false);
      await channel.destroy();
      this.segmentChannels.delete(id);
      const index = this.allChannels.indexOf(channel);
      if (index >= 0) this.allChannels.splice(index, 1);
    }
    if (this.lastState) this.syncState(this.lastState);
  }

  private async createChannel(
    nativeId: string,
    name: string,
  ): Promise<FreeAtHomeOnOffChannel> {
    const channel = await this.freeAtHome.createSwitchingActuatorDevice(
      nativeId,
      name,
    );
    channel.setAutoConfirm(false);
    channel.setAutoKeepAlive(true);
    this.allChannels.push(channel);
    return channel;
  }

  private async createDimmerChannel(
    nativeId: string,
    name: string,
  ): Promise<ResponsiveDimmerChannel> {
    const rawChannel = await this.freeAtHome.createRawDevice(
      nativeId,
      name,
      "DimActuator",
    );
    const channel = new ResponsiveDimmerChannel(rawChannel, {
      fullRangeDurationMs: this.config.relativeDimDurationMs,
      minimumBrightnessPercent: this.config.minimumBrightnessPercent,
      logger: this.logger,
    });
    channel.setAutoKeepAlive(true);
    this.allChannels.push(channel);
    return channel;
  }

  private async createPresetChannel(presetDevice: PresetDevicePlan): Promise<void> {
    const channel = await this.createChannel(
      presetDevice.nativeId,
      presetDevice.name,
    );
    channel.setOn(false);
    channel.on("isOnChanged", (isOn: boolean) => {
      if (!isOn) {
        channel.setOn(false);
        return;
      }
      void this.handlePresetCommand(
        channel,
        presetDevice.preset,
        `preset-${presetDevice.preset.id}`,
      );
    });
    this.presetChannels.set(presetDevice.preset.id, channel);
  }

  private async createPresetNavigationChannel(
    navigationDevice: NavigationDevicePlan,
  ): Promise<void> {
    const channel = await this.createChannel(
      navigationDevice.nativeId,
      navigationDevice.name,
    );
    channel.setOn(false);
    channel.on("isOnChanged", (isOn: boolean) => {
      if (!isOn) {
        channel.setOn(false);
        return;
      }
      // A physical switch can send its next pulse only after this virtual
      // switching actuator has reported off again. Re-arm it immediately;
      // WLED may take several seconds to finish the visual transition.
      channel.setOn(false);
      void this.activateAdjacentPreset(navigationDevice.direction);
    });
  }

  private async handleMasterCommand(isOn: boolean): Promise<void> {
    try {
      const state = await this.wled.setMasterOn(isOn);
      this.syncState(state);
    } catch (error) {
      this.logger.error(`Main switch failed: ${toError(error).message}`);
      await this.masterChannel?.setUnresponsive();
    }
  }

  private async handleSegmentCommand(
    channel: FreeAtHomeOnOffChannel,
    segmentId: number,
    isOn: boolean,
  ): Promise<void> {
    try {
      const state = await this.wled.setSegmentOn(segmentId, isOn);
      this.syncState(state);
    } catch (error) {
      this.logger.error(
        `Switching segment ${segmentId} failed: ${toError(error).message}`,
      );
      await channel.setUnresponsive();
    }
  }

  private async handleBrightnessCommand(
    percentage: number,
    source: "absolute" | "relative",
  ): Promise<void> {
    try {
      const transitionDeciseconds = source === "relative" ? 1 : undefined;
      const state = await this.wled.setBrightnessPercent(
        percentage,
        transitionDeciseconds,
      );
      this.syncState(state);
    } catch (error) {
      this.logger.error(
        `Dimming to ${percentage}% failed: ${toError(error).message}`,
      );
      await this.masterChannel?.setUnresponsive();
    }
  }

  private async handlePresetCommand(
    channel: FreeAtHomeOnOffChannel | undefined,
    preset: WledPreset,
    pulseKey: string,
  ): Promise<void> {
    try {
      const state = await this.wled.applyPreset(preset.id);
      this.syncState(state);
      if (channel) {
        this.pulsePresetChannel(pulseKey, channel);
      }
    } catch (error) {
      channel?.setOn(false);
      this.logger.error(
        `Preset ${preset.id} (${preset.name}) failed: ${toError(error).message}`,
      );
      await channel?.setUnresponsive();
    }
  }

  private pulsePresetChannel(
    key: string,
    channel: FreeAtHomeOnOffChannel,
  ): void {
    const existing = this.pulseTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    channel.setOn(true);
    const timer = setTimeout(() => {
      channel.setOn(false);
      this.pulseTimers.delete(key);
    }, 750);
    this.pulseTimers.set(key, timer);
  }

  private async activateAdjacentPreset(
    direction: 1 | -1,
    triggerChannel?: FreeAtHomeOnOffChannel,
    pulseKey = "long-press",
    basisPresetId = this.lastState?.ps,
  ): Promise<void> {
    const preset = this.findAdjacentPreset(direction, basisPresetId);
    if (!preset) {
      triggerChannel?.setOn(false);
      return;
    }

    await this.handlePresetCommand(triggerChannel, preset, pulseKey);
    if (!triggerChannel) {
      const presetChannel = this.presetChannels.get(preset.id);
      if (presetChannel) {
        this.pulsePresetChannel(`preset-${preset.id}`, presetChannel);
      }
    }
  }

  private findAdjacentPreset(
    direction: 1 | -1,
    basisPresetId: number | undefined,
  ): WledPreset | undefined {
    if (this.availablePresets.length === 0) {
      return undefined;
    }

    const currentIndex = this.availablePresets.findIndex(
      (preset) => preset.id === basisPresetId,
    );
    if (currentIndex < 0) {
      return direction > 0
        ? this.availablePresets[0]
        : this.availablePresets[this.availablePresets.length - 1];
    }

    const nextIndex =
      (currentIndex + direction + this.availablePresets.length) %
      this.availablePresets.length;
    return this.availablePresets[nextIndex];
  }

  private enterPresetMode(): void {
    this.presetModeActive = true;
    this.recentOnPresses.length = 0;
    this.clearPresetModeExitTimer();
    this.masterChannel?.setRelativeDimmingSuppressed(true);
  }

  private recordPresetActivationPress(): boolean {
    if (!this.config.presetTriplePressEnabled || this.availablePresets.length < 2) {
      return false;
    }
    const now = Date.now();
    const windowMs = this.config.presetTriplePressWindowMs ?? 4_000;
    while (this.recentOnPresses.length && now - this.recentOnPresses[0] > windowMs) {
      this.recentOnPresses.shift();
    }
    this.recentOnPresses.push(now);
    if (this.recentOnPresses.length < (this.config.presetTriplePressCount ?? 3)) return false;
    this.enterPresetMode();
    this.schedulePresetModeExit();
    return true;
  }

  private schedulePresetModeExit(): void {
    this.clearPresetModeExitTimer();
    this.presetModeExitTimer = setTimeout(() => {
      this.presetModeExitTimer = undefined;
      this.exitPresetMode();
    }, this.presetModeIdleMs);
  }

  private clearPresetModeExitTimer(): void {
    if (this.presetModeExitTimer) {
      clearTimeout(this.presetModeExitTimer);
      this.presetModeExitTimer = undefined;
    }
  }

  private exitPresetMode(): void {
    this.clearPresetModeExitTimer();
    this.presetModeActive = false;
    this.masterChannel?.setRelativeDimmingSuppressed(false);
  }

  private syncState(state: WledState): void {
    this.lastState = state;
    this.masterChannel?.setOnOff(state.on);
    this.masterChannel?.setValue(brightnessByteToPercent(state.bri));

    for (const [segmentId, channel] of this.segmentChannels) {
      const segment = state.seg.find((candidate) => candidate.id === segmentId);
      if (segment) {
        channel.setOn(state.on && segment.on);
      }
    }
  }

  private async updateReachability(online: boolean): Promise<void> {
    if (online) {
      await Promise.allSettled(
        this.allChannels.map((channel) => channel.triggerKeepAlive()),
      );
      if (this.lastState) {
        this.syncState(this.lastState);
      }
      return;
    }

    await Promise.allSettled(
      this.allChannels.map((channel) => channel.setUnresponsive()),
    );
  }
}

function createStableId(info: WledInfo, fallback: string): string {
  const source = info.mac?.trim() || fallback;
  return source.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "controller";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface ManagedChannel {
  setAutoKeepAlive(value: boolean): void;
  setUnresponsive(): Promise<void>;
  triggerKeepAlive(): Promise<void>;
  destroy(): Promise<void>;
}

interface StopOptions {
  removeVirtualDevices?: boolean;
}

export interface VirtualDevicePlan {
  master: MasterDevicePlan;
  segments: SegmentDevicePlan[];
  presets: PresetDevicePlan[];
  navigation: NavigationDevicePlan[];
}

interface MasterDevicePlan {
  nativeId: string;
  name: string;
}

interface SegmentDevicePlan {
  nativeId: string;
  name: string;
  segmentId: number;
}

export interface PresetDevicePlan {
  nativeId: string;
  name: string;
  preset: WledPreset;
}

export interface NavigationDevicePlan {
  nativeId: string;
  name: string;
  key: "next" | "previous";
  direction: 1 | -1;
}

export function buildVirtualDevicePlan(
  snapshot: WledSnapshot,
  config: WledAddonConfig,
): VirtualDevicePlan {
  const stableId = createStableId(snapshot.info, config.wledIp);
  const segments = [...snapshot.state.seg]
    .sort((left, right) => left.id - right.id)
    .map((segment): SegmentDevicePlan => ({
      nativeId: `wled-${stableId}-segment-${segment.id}`,
      name:
        config.segmentNames.get(segment.id) ??
        (segment.name?.trim() || `WLED segment ${segment.id + 1}`),
      segmentId: segment.id,
    }));

  const presets = snapshot.presets
    .filter((preset) => {
      if (config.visiblePresetIds && !config.visiblePresetIds.has(preset.id)) {
        return false;
      }
      return true;
    })
    .map((preset): PresetDevicePlan => ({
      nativeId: `wled-${stableId}-preset-${preset.id}`,
      name: `Preset ${preset.name}`,
      preset,
    }));

  const navigation: NavigationDevicePlan[] =
    config.createPresetNavigationButtons && presets.length >= 2
      ? ([
          {
            nativeId: `wled-${stableId}-preset-next`,
            name: "Next preset",
            key: "next",
            direction: 1,
          },
          {
            nativeId: `wled-${stableId}-preset-previous`,
            name: "Previous preset",
            key: "previous",
            direction: -1,
          },
        ] as NavigationDevicePlan[]).filter((device) =>
          device.key === "next"
            ? config.createNextPresetButton !== false
            : config.createPreviousPresetButton !== false,
        )
      : [];

  return {
    master: {
      nativeId: `wled-${stableId}-master-dimmer`,
      name: config.masterName,
    },
    segments,
    presets,
    navigation,
  };
}

export function isPresetSafe(
  preset: WledPreset,
  currentState: WledState,
): boolean {
  if (!preset.segmentBounds) {
    return true;
  }

  const currentSegments = new Map(
    currentState.seg.map((segment) => [segment.id, segment]),
  );

  return preset.segmentBounds.every((boundary) => {
    const current = currentSegments.get(boundary.id);
    if (!current) {
      return boundary.stop === 0;
    }

    return (
      (boundary.start === undefined || boundary.start === current.start) &&
      (boundary.stop === undefined || boundary.stop === current.stop)
    );
  });
}
