export interface WledSegment {
  id: number;
  start: number;
  stop: number;
  on: boolean;
  bri?: number;
  fx?: number;
  pal?: number;
  name?: string;
}

export interface WledState {
  on: boolean;
  bri: number;
  ps?: number;
  seg: WledSegment[];
}

export interface WledInfo {
  ver: string;
  vid?: number;
  arch?: string;
  brand?: string;
  product?: string;
  mac?: string;
  name?: string;
}

export interface WledPreset {
  id: number;
  name: string;
  isPlaylist: boolean;
  segmentBounds?: WledPresetSegmentBoundary[];
}

export interface WledPresetSegmentBoundary {
  id: number;
  start?: number;
  stop?: number;
}

export interface WledSnapshot {
  info: WledInfo;
  state: WledState;
  presets: WledPreset[];
}

export function isWledState(value: unknown): value is WledState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WledState>;
  return (
    typeof candidate.on === "boolean" &&
    typeof candidate.bri === "number" &&
    Array.isArray(candidate.seg)
  );
}

export function extractWledState(value: unknown): WledState | undefined {
  if (isWledState(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const nested = (value as { state?: unknown }).state;
    if (isWledState(nested)) {
      return nested;
    }
  }

  return undefined;
}

export function parsePresets(value: unknown): WledPreset[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const presets: WledPreset[] = [];
  for (const [rawId, rawPreset] of Object.entries(value)) {
    const id = Number(rawId);
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > 250 ||
      !rawPreset ||
      typeof rawPreset !== "object"
    ) {
      continue;
    }

    const preset = rawPreset as {
      n?: unknown;
      playlist?: unknown;
      seg?: unknown;
    };
    if (typeof preset.n !== "string" || preset.n.trim().length === 0) {
      continue;
    }

    const parsedPreset: WledPreset = {
      id,
      name: preset.n.trim(),
      isPlaylist: Array.isArray(preset.playlist),
    };
    const segmentBounds = parsePresetSegmentBounds(preset.seg);
    if (segmentBounds && segmentBounds.length > 0) {
      parsedPreset.segmentBounds = segmentBounds;
    }
    presets.push(parsedPreset);
  }

  return presets.sort((left, right) => left.id - right.id);
}

function parsePresetSegmentBounds(
  rawSegments: unknown,
): WledPresetSegmentBoundary[] | undefined {
  if (!Array.isArray(rawSegments)) {
    return undefined;
  }

  const result: WledPresetSegmentBoundary[] = [];
  rawSegments.forEach((rawSegment, index) => {
    if (!rawSegment || typeof rawSegment !== "object") {
      return;
    }

    const segment = rawSegment as {
      id?: unknown;
      start?: unknown;
      stop?: unknown;
    };
    const id = Number.isInteger(segment.id) ? Number(segment.id) : index;
    const start =
      typeof segment.start === "number" ? segment.start : undefined;
    const stop = typeof segment.stop === "number" ? segment.stop : undefined;

    if (start !== undefined || stop !== undefined) {
      result.push({ id, start, stop });
    }
  });

  return result;
}
