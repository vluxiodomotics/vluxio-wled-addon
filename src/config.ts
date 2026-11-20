import { AddOn } from "@busch-jaeger/free-at-home";

export interface WledAddonConfig {
  controllerKey?: string;
  additionalControllers?: WledAddonConfig[];
  wledIp: string;
  wledMacAddress?: string;
  secondaryWledIp?: string;
  secondaryWledMacAddress?: string;
  secondaryMasterName?: string;
  secondaryVisiblePresetIds?: ReadonlySet<number>;
  secondaryCreateNextPresetButton?: boolean;
  secondaryCreatePreviousPresetButton?: boolean;
  secondaryPresetTriplePressEnabled?: boolean;
  secondaryPresetTriplePressCount?: number;
  secondaryPresetTriplePressWindowMs?: number;
  pollIntervalSeconds: number;
  autoDiscoveryEnabled: boolean;
  rediscoveryIntervalSeconds: number;
  relativeDimDurationMs: number;
  minimumBrightnessPercent: number;
  masterName: string;
  segmentNames: Map<number, string>;
  visiblePresetIds?: ReadonlySet<number>;
  createPresetNavigationButtons: boolean;
  createNextPresetButton?: boolean;
  createPreviousPresetButton?: boolean;
  presetTriplePressEnabled?: boolean;
  presetTriplePressCount?: number;
  presetTriplePressWindowMs?: number;
}

const DEFAULTS: WledAddonConfig = {
  wledIp: "192.168.1.50",
  wledMacAddress: undefined,
  pollIntervalSeconds: 10,
  autoDiscoveryEnabled: true,
  rediscoveryIntervalSeconds: 180,
  relativeDimDurationMs: 5_000,
  minimumBrightnessPercent: 1,
  masterName: "WLED lighting",
  segmentNames: new Map([
    [0, "WLED segment 1"],
    [1, "WLED segment 2"],
    [2, "WLED segment 3"],
  ]),
  visiblePresetIds: undefined,
  createPresetNavigationButtons: true,
  createNextPresetButton: false,
  createPreviousPresetButton: false,
  presetTriplePressEnabled: false,
  presetTriplePressCount: 3,
  presetTriplePressWindowMs: 4_000,
};

export function parseConfiguration(
  configuration: AddOn.Configuration,
): WledAddonConfig {
  const pollInterval = Number(
    readItem(configuration, "connection", "pollInterval"),
  );
  const primaryIp = readOptionalString(configuration, "controller1", "wledIp");
  const legacyIp = readOptionalStringExact(configuration, "connection", "wledIp");

  const parsed: WledAddonConfig = {
    controllerKey: "controller1",
    wledIp: primaryIp === DEFAULTS.wledIp && legacyIp && legacyIp !== DEFAULTS.wledIp
      ? legacyIp : primaryIp ?? legacyIp ?? DEFAULTS.wledIp,
    pollIntervalSeconds:
      Number.isFinite(pollInterval) && pollInterval >= 5
        ? Math.min(300, pollInterval)
        : DEFAULTS.pollIntervalSeconds,
    wledMacAddress: readOptionalMacAddress(
      configuration,
      "controller1",
      "wledMacAddress",
    ) ?? readOptionalMacAddress(configuration, "connection", "wledMacAddress"),
    secondaryWledIp: readOptionalString(configuration, "controller2", "secondaryWledIp") ?? readOptionalString(configuration, "connection", "secondaryWledIp"),
    secondaryWledMacAddress: readOptionalMacAddress(configuration, "controller2", "secondaryWledMacAddress") ?? readOptionalMacAddress(configuration, "connection", "secondaryWledMacAddress"),
    secondaryMasterName: readOptionalString(configuration, "controller2", "secondaryMasterName") ?? readOptionalString(configuration, "devices", "secondaryMasterName"),
    secondaryVisiblePresetIds: parsePresetIds(readItem(configuration, "controller2", "secondaryVisiblePresetIds")),
    secondaryCreateNextPresetButton: readBoolean(configuration, "controller2", "secondaryCreateNextPresetButton", false),
    secondaryCreatePreviousPresetButton: readBoolean(configuration, "controller2", "secondaryCreatePreviousPresetButton", false),
    secondaryPresetTriplePressEnabled: readBoolean(configuration, "controller2", "secondaryMultiPressEnabled", false),
    secondaryPresetTriplePressCount: boundedNumber(readItem(configuration, "controller2", "secondaryMultiPressCount"), 3, 2, 6),
    secondaryPresetTriplePressWindowMs: secondsToMs(readItem(configuration, "controller2", "secondaryMultiPressWindowSeconds"), 4, 2, 10),
    autoDiscoveryEnabled: readBoolean(
      configuration,
      "connection",
      "autoDiscoveryEnabled",
      DEFAULTS.autoDiscoveryEnabled,
    ),
    rediscoveryIntervalSeconds: Math.max(
      60,
      Math.min(
        3600,
        Number(readItem(configuration, "connection", "rediscoveryInterval")) ||
          DEFAULTS.rediscoveryIntervalSeconds,
      ),
    ),
    relativeDimDurationMs:
      Math.max(
        1,
        Math.min(
          10,
          Number(readItem(configuration, "devices", "relativeDimDuration")) ||
            DEFAULTS.relativeDimDurationMs / 1_000,
        ),
      ) * 1_000,
    minimumBrightnessPercent: Math.max(
      1,
      Math.min(
        20,
        Number(readItem(configuration, "devices", "minimumBrightness")) ||
          DEFAULTS.minimumBrightnessPercent,
      ),
    ),
    masterName: readString(
      configuration,
      "controller1",
      "masterName",
      readString(configuration, "devices", "masterName", DEFAULTS.masterName),
    ),
    segmentNames: new Map([
      [
        0,
        readString(
          configuration,
          "devices",
          "segment0Name",
          DEFAULTS.segmentNames.get(0)!,
        ),
      ],
      [
        1,
        readString(
          configuration,
          "devices",
          "segment1Name",
          DEFAULTS.segmentNames.get(1)!,
        ),
      ],
      [
        2,
        readString(
          configuration,
          "devices",
          "segment2Name",
          DEFAULTS.segmentNames.get(2)!,
        ),
      ],
    ]),
    visiblePresetIds: parsePresetIds(
      readItem(configuration, "controller1", "visiblePresetIds") ||
      readItem(configuration, "presets", "visiblePresetIds") ||
      legacyPresetIdsFromMacField(configuration),
    ),
    createPresetNavigationButtons: true,
    createNextPresetButton: readBoolean(
      configuration, "controller1", "createNextPresetButton", readBoolean(configuration, "presets", "createNextPresetButton", false),
    ),
    createPreviousPresetButton: readBoolean(
      configuration, "controller1", "createPreviousPresetButton", readBoolean(configuration, "presets", "createPreviousPresetButton", false),
    ),
    presetTriplePressEnabled: readBoolean(
      configuration,
      "controller1",
      "triplePressEnabled",
      readBoolean(configuration, "presets", "triplePressEnabled", DEFAULTS.presetTriplePressEnabled ?? false),
    ),
    presetTriplePressCount: boundedNumber(readItem(configuration, "controller1", "multiPressCount"), 3, 2, 6),
    presetTriplePressWindowMs:
      Math.max(2, Math.min(10,
        Number(readItem(configuration, "controller1", "triplePressWindowSeconds") ?? readItem(configuration, "presets", "triplePressWindowSeconds")) || 4,
      )) * 1_000,
  };
  parsed.additionalControllers = parseAdditionalControllers(configuration, parsed);
  return parsed;
}

function parseAdditionalControllers(configuration: AddOn.Configuration, base: WledAddonConfig): WledAddonConfig[] {
  const group = configuration.controllers;
  if (!group || typeof group !== "object") return [];
  const entries = group as Record<string, unknown>;
  return Object.entries(entries).flatMap(([key, entry], index) => {
    if (!entry || typeof entry !== "object" || !("items" in entry)) return [];
    const items = (entry as { items: Record<string, unknown> }).items;
    if (items.$disabled === true || typeof items.wledIp !== "string" || !items.wledIp.trim()) return [];
    const read = (key: string) => items[key];
    const bool = (key: string) => read(key) === true || read(key) === "true" || read(key) === "1";
    return [{
      ...base,
      controllerKey: key,
      additionalControllers: undefined,
      wledIp: items.wledIp.trim(),
      wledMacAddress: typeof items.wledMacAddress === "string"
        ? items.wledMacAddress.replace(/[^a-fA-F0-9]/g, "").toLowerCase() || undefined
        : undefined,
      masterName: typeof items.masterName === "string" && items.masterName.trim() ? items.masterName.trim() : `WLED lighting ${index + 2}`,
      visiblePresetIds: parsePresetIds(read("visiblePresetIds")),
      createNextPresetButton: bool("createNextPresetButton"),
      createPreviousPresetButton: bool("createPreviousPresetButton"),
      presetTriplePressEnabled: bool("triplePressEnabled"),
      presetTriplePressCount: boundedNumber(read("multiPressCount"), 3, 2, 6),
      presetTriplePressWindowMs: secondsToMs(read("multiPressWindowSeconds"), 4, 2, 10),
    }];
  });
}

export function migrateLegacySecondController(configuration: AddOn.Configuration): AddOn.Configuration | undefined {
  const legacy = readOptionalString(configuration, "controller2", "secondaryWledIp")
    ?? readOptionalStringExact(configuration, "connection", "secondaryWledIp");
  if (!legacy) return undefined;
  const existing = configuration.controllers as Record<string, unknown> | undefined;
  if (existing && Object.values(existing).some((entry) => {
    const items = (entry as { items?: Record<string, unknown> })?.items;
    return items?.wledIp === legacy;
  })) return undefined;
  const old = (configuration.controller2 as { items?: Record<string, unknown> } | undefined)?.items ?? {};
  return {
    ...configuration,
    controller2: { items: { ...old, secondaryWledIp: "" } },
    connection: configuration.connection && "items" in configuration.connection
      ? { ...configuration.connection, items: { ...configuration.connection.items, secondaryWledIp: "" } }
      : configuration.connection,
    controllers: {
      ...(existing ?? {}),
      "legacy-controller-2": { items: {
        wledIp: legacy,
        wledMacAddress: old.secondaryWledMacAddress ?? readItem(configuration, "connection", "secondaryWledMacAddress") ?? "",
        masterName: old.secondaryMasterName ?? readItem(configuration, "devices", "secondaryMasterName") ?? "WLED lighting 2",
        visiblePresetIds: old.secondaryVisiblePresetIds ?? "",
        createNextPresetButton: old.secondaryCreateNextPresetButton ?? false,
        createPreviousPresetButton: old.secondaryCreatePreviousPresetButton ?? false,
        triplePressEnabled: old.secondaryMultiPressEnabled ?? false,
        multiPressCount: old.secondaryMultiPressCount ?? 3,
        multiPressWindowSeconds: old.secondaryMultiPressWindowSeconds ?? 4,
      } },
    },
  } as AddOn.Configuration;
}

export function migrateLegacyPrimaryIp(configuration: AddOn.Configuration): AddOn.Configuration | undefined {
  const current = readOptionalString(configuration, "controller1", "wledIp");
  const legacy = readOptionalStringExact(configuration, "connection", "wledIp");
  if (!legacy || legacy === current || (current && current !== DEFAULTS.wledIp)) {
    return undefined;
  }
  const controller = configuration.controller1;
  if (!controller || typeof controller !== "object" || !("items" in controller)) {
    return undefined;
  }
  return {
    ...configuration,
    controller1: {
      ...controller,
      items: { ...(controller as { items: Record<string, unknown> }).items, wledIp: legacy },
    },
  } as AddOn.Configuration;
}

export function configuredControllers(config: WledAddonConfig): WledAddonConfig[] {
  const extra = config.additionalControllers ?? [];
  if (extra.length > 0) return validateControllers([config, ...extra]);
  if (!config.secondaryWledIp) return [config];
  if (!isValidIpv4(config.secondaryWledIp)) {
    throw new Error("Het IP-adres van de tweede WLED-controller is ongeldig.");
  }
  if (config.secondaryWledIp === config.wledIp) {
    throw new Error("De twee WLED-controllers mogen niet hetzelfde IP-adres hebben.");
  }
  if (config.wledMacAddress && config.secondaryWledMacAddress === config.wledMacAddress) {
    throw new Error("De twee WLED-controllers mogen niet hetzelfde MAC-adres hebben.");
  }
  return validateControllers([config, {
    ...config,
    controllerKey: "legacy-controller-2",
    wledIp: config.secondaryWledIp,
    wledMacAddress: config.secondaryWledMacAddress,
    masterName: config.secondaryMasterName || "WLED lighting 2",
    visiblePresetIds: config.secondaryVisiblePresetIds,
    createNextPresetButton: config.secondaryCreateNextPresetButton,
    createPreviousPresetButton: config.secondaryCreatePreviousPresetButton,
    presetTriplePressEnabled: config.secondaryPresetTriplePressEnabled ?? false,
    presetTriplePressCount: config.secondaryPresetTriplePressCount ?? 3,
    presetTriplePressWindowMs: config.secondaryPresetTriplePressWindowMs ?? 4_000,
  }]);
}

function validateControllers(controllers: WledAddonConfig[]): WledAddonConfig[] {
  if (controllers.length > 4) throw new Error("Maximaal vier WLED-controllers in deze testversie.");
  const ips = new Set<string>();
  for (const controller of controllers) {
    if (!isValidIpv4(controller.wledIp)) throw new Error(`Ongeldig WLED-IP-adres: ${controller.wledIp}`);
    if (ips.has(controller.wledIp)) throw new Error("WLED-controllers mogen niet hetzelfde IP-adres hebben.");
    ips.add(controller.wledIp);
  }
  return controllers;
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.min(max, Math.floor(parsed)) : fallback;
}

function secondsToMs(value: unknown, fallback: number, min: number, max: number): number {
  return boundedNumber(value, fallback, min, max) * 1_000;
}

function readOptionalString(configuration: AddOn.Configuration, group: string, key: string): string | undefined {
  const value = readItem(configuration, group, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalStringExact(configuration: AddOn.Configuration, group: string, key: string): string | undefined {
  const entry = configuration[group];
  const value = entry && typeof entry === "object" && "items" in entry
    ? (entry as { items: Record<string, unknown> }).items[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readItem(
  configuration: AddOn.Configuration,
  group: string,
  key: string,
): unknown {
  const groups = group === "connection" || group === "devices" || group === "presets"
    ? [group, "advanced", "controller1", "controller2"]
    : [group];
  for (const candidate of groups) {
    const entry = configuration[candidate];
    if (entry && typeof entry === "object" && "items" in entry) {
      const items = (entry as { items: Record<string, unknown> }).items;
      if (Object.prototype.hasOwnProperty.call(items, key)) return items[key];
    }
  }
  return undefined;
}

function readString(
  configuration: AddOn.Configuration,
  group: string,
  key: string,
  fallback: string,
): string {
  const value = readItem(configuration, group, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readBoolean(
  configuration: AddOn.Configuration,
  group: string,
  key: string,
  fallback: boolean,
): boolean {
  const value = readItem(configuration, group, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return fallback;
}

function readOptionalMacAddress(
  configuration: AddOn.Configuration,
  group: string,
  key: string,
): string | undefined {
  const value = readItem(configuration, group, key);
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  return normalized.length === 12 ? normalized : undefined;
}

function legacyPresetIdsFromMacField(configuration: AddOn.Configuration): unknown {
  const value = readItem(configuration, "connection", "wledMacAddress");
  return typeof value === "string" && /^[0-9,;\s-]+$/.test(value.trim())
    ? value
    : undefined;
}

function parsePresetIds(value: unknown): ReadonlySet<number> | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const result = new Set<number>();
  for (const token of value.split(/[\s,;]+/)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 1 &&
        end <= 250 &&
        start <= end
      ) {
        for (let id = start; id <= end; id += 1) {
          result.add(id);
        }
      }
      continue;
    }

    const id = Number(token);
    if (Number.isInteger(id) && id >= 1 && id <= 250) {
      result.add(id);
    }
  }

  return result.size > 0 ? result : undefined;
}
