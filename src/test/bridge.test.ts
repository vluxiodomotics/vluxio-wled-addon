import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  FreeAtHome,
  FreeAtHomeOnOffChannel,
  FreeAtHomeRawChannel,
  PairingIds,
} from "@busch-jaeger/free-at-home";
import { buildVirtualDevicePlan, WledFreeAtHomeBridge } from "../bridge";
import { WledAddonConfig } from "../config";
import { WledClient } from "../wled/WledClient";
import { WledSnapshot, WledState } from "../wled/types";

class FakeBaseChannel extends EventEmitter {
  public autoConfirm = true;
  public autoKeepAlive = false;
  public unresponsive = false;
  public destroyed = false;

  public setAutoConfirm(value: boolean): void {
    this.autoConfirm = value;
  }
  public setAutoKeepAlive(value: boolean): void {
    this.autoKeepAlive = value;
  }
  public async setUnresponsive(): Promise<void> {
    this.unresponsive = true;
  }
  public async triggerKeepAlive(): Promise<void> {
    this.unresponsive = false;
  }
  public async destroy(): Promise<void> {
    this.destroyed = true;
    this.setAutoKeepAlive(false);
    this.removeAllListeners();
  }
}

class FakeSwitchChannel extends FakeBaseChannel {
  public feedback = false;

  public setOn(value: boolean): void {
    this.feedback = value;
  }
}

class FakeRawChannel extends FakeBaseChannel {
  public readonly outputs = new Map<PairingIds, string>();

  public async setOutputDatapoint(
    id: PairingIds,
    value: string,
  ): Promise<void> {
    this.outputs.set(id, value);
  }
}

class FakeMediaChannel extends FakeBaseChannel {
  public playlists: string[] = [];
  public playlistIndex?: number;
  public setAutoConfirm(_value: boolean): void {}
  public async setPlaylists(value: string[]): Promise<void> { this.playlists = value; }
  public async setPlaylistIndex(value: number): Promise<void> { this.playlistIndex = value; }
  public async setOn(_value: boolean): Promise<void> {}
}

class FakeFreeAtHome {
  public readonly rawChannels = new Map<string, FakeRawChannel>();
  public readonly switches = new Map<string, FakeSwitchChannel>();
  public readonly mediaChannels = new Map<string, FakeMediaChannel>();

  public async createMediaPlayerDevice(nativeId: string) {
    const channel = new FakeMediaChannel();
    this.mediaChannels.set(nativeId, channel);
    return channel;
  }

  public async createRawDevice(nativeId: string) {
    const channel = new FakeRawChannel();
    this.rawChannels.set(nativeId, channel);
    return channel as unknown as FreeAtHomeRawChannel;
  }

  public async createSwitchingActuatorDevice(nativeId: string) {
    const channel = new FakeSwitchChannel();
    this.switches.set(nativeId, channel);
    return channel as unknown as FreeAtHomeOnOffChannel;
  }
}

class FakeWledClient extends EventEmitter {
  public readonly commands: Array<[string, number | boolean]> = [];
  public readonly brightnessTransitions: Array<number | undefined> = [];

  public constructor(
    private state: WledState,
    private readonly snapshot: WledSnapshot,
  ) {
    super();
  }

  public async start(): Promise<WledSnapshot> {
    return this.snapshot;
  }
  public stop(): void {}

  public async setMasterOn(value: boolean): Promise<WledState> {
    this.commands.push(["master", value]);
    this.state = { ...this.state, on: value };
    return this.state;
  }

  public async setBrightnessPercent(
    value: number,
    transitionDeciseconds?: number,
  ): Promise<WledState> {
    this.commands.push(["brightness", value]);
    this.brightnessTransitions.push(transitionDeciseconds);
    this.state = {
      ...this.state,
      on: value > 0,
      bri: Math.round((value * 255) / 100),
    };
    return this.state;
  }

  public async setSegmentOn(
    segmentId: number,
    value: boolean,
  ): Promise<WledState> {
    this.commands.push([`segment-${segmentId}`, value]);
    this.state = {
      ...this.state,
      on: value ? true : this.state.on,
      seg: this.state.seg.map((segment) =>
        segment.id === segmentId ? { ...segment, on: value } : segment,
      ),
    };
    return this.state;
  }

  public async applyPreset(presetId: number): Promise<WledState> {
    this.commands.push(["preset", presetId]);
    this.state = { ...this.state, on: true, ps: presetId };
    return this.state;
  }
}

test("segment reconciliation keeps stable IDs and ignores reachability loss", async () => {
  const state: WledState = { on: true, bri: 100, seg: [
    { id: 0, start: 0, stop: 10, on: true },
    { id: 2, start: 10, stop: 20, on: true },
  ] };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, { info: { ver: "1", mac: "AABBCCDDEEFF" }, state, presets: [] });
  const bridge = new WledFreeAtHomeBridge(fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient, createConfig(), { info() {}, warn() {}, error() {} });
  await bridge.start();
  const original = fakeFreeAtHome.switches.get("wled-AABBCCDDEEFF-segment-2")!;
  fakeWled.emit("online", false);
  await nextTurn();
  assert.equal(original.destroyed, false);
  fakeWled.emit("segments", [state.seg[1], { id: 5, start: 20, stop: 30, on: true }]);
  await nextTurn();
  assert.equal(fakeFreeAtHome.switches.get("wled-AABBCCDDEEFF-segment-5")?.destroyed, false);
  assert.equal(fakeFreeAtHome.switches.get("wled-AABBCCDDEEFF-segment-0")?.destroyed, true);
  assert.equal(original.destroyed, false);
  await bridge.stop();
});

test("bridge exposes a responsive raw dimmer for absolute and relative values", async () => {
  const state: WledState = {
    on: true,
    bri: 102,
    ps: 1,
    seg: [
      { id: 0, start: 0, stop: 87, on: true },
      { id: 1, start: 88, stop: 174, on: true },
      { id: 2, start: 175, stop: 262, on: true },
    ],
  };
  const snapshot: WledSnapshot = {
    info: {
      ver: "16.0.0",
      product: "Dig-Quad-V3",
      mac: "AABBCCDDEEFF",
    },
    state,
    presets: [{ id: 1, name: "Warm wit", isPlaylist: false }],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const expectedFirstRelativeBrightness =
    100 * Math.pow(Math.sqrt(0.6) - 0.01, 2);
  const config: WledAddonConfig = {
    wledIp: "192.168.1.50",
    wledMacAddress: undefined,
    pollIntervalSeconds: 10,
    autoDiscoveryEnabled: true,
    rediscoveryIntervalSeconds: 180,
    relativeDimDurationMs: 5_000,
    minimumBrightnessPercent: 1,
    masterName: "Plafondverlichting",
    visiblePresetIds: undefined,
    createPresetNavigationButtons: true,
    segmentNames: new Map([
      [0, "Sectie 1"],
      [1, "Sectie 2"],
      [2, "Sectie 3"],
    ]),
  };
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    config,
    { info() {}, warn() {}, error() {} },
  );

  await bridge.start();

  const dimmer = [...fakeFreeAtHome.rawChannels.values()][0];
  assert.ok(dimmer);
  assert.equal(dimmer.outputs.get(PairingIds.AL_INFO_ON_OFF), "1");
  assert.equal(
    dimmer.outputs.get(PairingIds.AL_INFO_ACTUAL_DIMMING_VALUE),
    "40",
  );
  assert.equal(fakeFreeAtHome.switches.size, 4);

  dimmer.emit(
    "datapointChanged",
    PairingIds.AL_SWITCH_ON_OFF,
    "1",
  );
  await nextTurn();
  assert.deepEqual(fakeWled.commands, [["master", true]]);

  dimmer.emit(
    "datapointChanged",
    PairingIds.AL_ABSOLUTE_SET_VALUE_CONTROL,
    "60",
  );
  await nextTurn();
  assert.deepEqual(fakeWled.commands, [
    ["master", true],
    ["brightness", 60],
  ]);
  assert.deepEqual(fakeWled.brightnessTransitions, [undefined]);

  dimmer.emit(
    "datapointChanged",
    PairingIds.AL_RELATIVE_SET_VALUE_CONTROL,
    "1",
  );
  await nextTurn();
  dimmer.emit(
    "datapointChanged",
    PairingIds.AL_RELATIVE_SET_VALUE_CONTROL,
    "0",
  );
  assert.deepEqual(fakeWled.commands, [
    ["master", true],
    ["brightness", 60],
    ["brightness", expectedFirstRelativeBrightness],
  ]);
  assert.deepEqual(fakeWled.brightnessTransitions, [undefined, 1]);

  dimmer.emit(
    "datapointChanged",
    PairingIds.AL_ABSOLUTE_SET_VALUE_CONTROL,
    "1",
  );
  await nextTurn();
  assert.deepEqual(fakeWled.commands, [
    ["master", true],
    ["brightness", 60],
    ["brightness", expectedFirstRelativeBrightness],
    ["brightness", 1],
  ]);

  await bridge.stop();
});

test("only selected presets become switch actors and navigation wraps", async () => {
  const state: WledState = {
    on: true,
    bri: 128,
    ps: 1,
    seg: [{ id: 0, start: 0, stop: 30, on: true }],
  };
  const snapshot: WledSnapshot = {
    info: { ver: "16.0.0", mac: "AABBCCDDEEFF" },
    state,
    presets: [
      { id: 1, name: "Warm wit", isPlaylist: false },
      { id: 4, name: "Niet zichtbaar", isPlaylist: false },
      { id: 5, name: "Feest", isPlaylist: false },
    ],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    createConfig({
      visiblePresetIds: new Set([1, 5]),
      createPresetNavigationButtons: true,
      createNextPresetButton: true,
      createPreviousPresetButton: false,
    }),
    { info() {}, warn() {}, error() {} },
  );

  await bridge.start();

  assert.equal(fakeFreeAtHome.mediaChannels.size, 0);
  assert.deepEqual([...fakeFreeAtHome.switches.keys()].sort(), [
    "wled-AABBCCDDEEFF-preset-1",
    "wled-AABBCCDDEEFF-preset-5",
    "wled-AABBCCDDEEFF-preset-next",
    "wled-AABBCCDDEEFF-segment-0",
  ]);
  const next = fakeFreeAtHome.switches.get("wled-AABBCCDDEEFF-preset-next");
  assert.ok(next);
  next.emit("isOnChanged", true);
  assert.equal(next.feedback, false, "navigation actor re-arms before WLED responds");
  await nextTurn();
  assert.equal(next.feedback, false, "navigation actor stays ready for another press");
  next.emit("isOnChanged", true);
  await nextTurn();
  next.emit("isOnChanged", true);
  await nextTurn();

  assert.deepEqual(
    fakeWled.commands.filter(([name]) => name === "preset"),
    [
      ["preset", 5],
      ["preset", 1],
      ["preset", 5],
    ],
  );

  await bridge.stop();
});

test("three on presses enter preset mode without a third switch command", async () => {
  const state: WledState = {
    on: true, bri: 128, ps: 1,
    seg: [{ id: 0, start: 0, stop: 30, on: true }],
  };
  const snapshot: WledSnapshot = {
    info: { ver: "16.0.0", mac: "AABBCCDDEEFF" },
    state,
    presets: [
      { id: 1, name: "Warm", isPlaylist: false },
      { id: 2, name: "Helder", isPlaylist: false },
    ],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    createConfig({ presetTriplePressEnabled: true, presetTriplePressWindowMs: 4_000 }),
    { info() {}, warn() {}, error() {} },
  );
  await bridge.start();
  const dimmer = [...fakeFreeAtHome.rawChannels.values()][0];
  for (let i = 0; i < 3; i++) {
    dimmer.emit("datapointChanged", PairingIds.AL_SWITCH_ON_OFF, "1");
    await nextTurn();
  }
  assert.equal(fakeWled.commands.filter(([name]) => name === "master").length, 2);
  await bridge.stop();
});

test("only selected preset navigation button is planned", () => {
  const snapshot: WledSnapshot = {
    info: { ver: "16.0.0", mac: "AABBCCDDEEFF" },
    state: { on: true, bri: 128, ps: 1, seg: [] },
    presets: [
      { id: 1, name: "Warm", isPlaylist: false },
      { id: 2, name: "Helder", isPlaylist: false },
    ],
  };
  const plan = buildVirtualDevicePlan(snapshot, createConfig({
    createNextPresetButton: true,
    createPreviousPresetButton: false,
  }));
  assert.deepEqual(plan.navigation.map((device) => device.key), ["next"]);
});

test("named presets are exposed even when they contain WLED segment boundaries", async () => {
  const state: WledState = {
    on: true,
    bri: 128,
    ps: 1,
    seg: [{ id: 0, start: 0, stop: 87, on: true }],
  };
  const snapshot: WledSnapshot = {
    info: { ver: "16.0.0", mac: "AABBCCDDEEFF" },
    state,
    presets: [
      {
        id: 4,
        name: "1 op 10",
        isPlaylist: false,
        segmentBounds: [{ id: 0, start: 4, stop: 87 }],
      },
    ],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    createConfig(),
    { info() {}, warn() {}, error() {} },
  );

  await bridge.start();

  assert.ok(fakeFreeAtHome.switches.has("wled-AABBCCDDEEFF-preset-4"));

  await bridge.stop();
});

test("all WLED segments are discovered once at startup", async () => {
  const state: WledState = {
    on: true,
    bri: 128,
    seg: Array.from({ length: 8 }, (_, id) => ({
      id,
      start: id * 10,
      stop: (id + 1) * 10,
      on: true,
      name: id === 7 ? "Werkblad" : undefined,
    })),
  };
  const snapshot: WledSnapshot = {
    info: { ver: "16.0.0", mac: "AABBCCDDEEFF" },
    state,
    presets: [],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    createConfig(),
    { info() {}, warn() {}, error() {} },
  );

  await bridge.start();

  assert.equal(fakeFreeAtHome.switches.size, 8);
  for (let segmentId = 0; segmentId < 8; segmentId += 1) {
    assert.ok(
      fakeFreeAtHome.switches.has(
        `wled-AABBCCDDEEFF-segment-${segmentId}`,
      ),
    );
  }

  await bridge.stop();
});

test("stop can remove all created virtual devices", async () => {
  const state: WledState = {
    on: true,
    bri: 128,
    ps: 1,
    seg: [{ id: 0, start: 0, stop: 30, on: true }],
  };
  const snapshot: WledSnapshot = {
    info: { product: "WLED", ver: "0.16.0", mac: "AA:BB:CC:DD:EE:FF" },
    state,
    presets: [{ id: 1, name: "Warm wit", isPlaylist: false }],
  };
  const fakeFreeAtHome = new FakeFreeAtHome();
  const fakeWled = new FakeWledClient(state, snapshot);
  const bridge = new WledFreeAtHomeBridge(
    fakeFreeAtHome as unknown as FreeAtHome,
    fakeWled as unknown as WledClient,
    createConfig(),
    { info() {}, warn() {}, error() {} },
  );

  await bridge.start();
  await bridge.stop({ removeVirtualDevices: true });

  assert.ok([...fakeFreeAtHome.rawChannels.values()].every((channel) => channel.destroyed));
  assert.ok([...fakeFreeAtHome.switches.values()].every((channel) => channel.destroyed));
});

function createConfig(
  overrides: Partial<WledAddonConfig> = {},
): WledAddonConfig {
  const defaults: WledAddonConfig = {
    wledIp: "192.168.1.50",
    wledMacAddress: undefined,
    pollIntervalSeconds: 10,
    autoDiscoveryEnabled: true,
    rediscoveryIntervalSeconds: 180,
    relativeDimDurationMs: 5_000,
    minimumBrightnessPercent: 1,
    masterName: "Plafondverlichting",
    segmentNames: new Map([[0, "Sectie 1"]]),
    visiblePresetIds: undefined,
    createPresetNavigationButtons: true,
  };
  return { ...defaults, ...overrides };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
