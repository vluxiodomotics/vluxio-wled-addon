import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWledState,
  isWledState,
  parsePresets,
} from "../wled/types";
import { isPresetSafe } from "../bridge";

test("parsePresets returns only named WLED presets in numeric order", () => {
  const presets = parsePresets({
    5: { n: "Vasteloavendj", seg: [] },
    0: {},
    4: { n: "1 op 10", seg: [] },
    2: { seg: [] },
    1: { n: " Warm wit ", seg: [] },
  });

  assert.deepEqual(presets, [
    { id: 1, name: "Warm wit", isPlaylist: false },
    { id: 4, name: "1 op 10", isPlaylist: false },
    { id: 5, name: "Vasteloavendj", isPlaylist: false },
  ]);
});

test("extractWledState accepts direct and websocket-wrapped state", () => {
  const state = {
    on: true,
    bri: 255,
    seg: [{ id: 0, start: 0, stop: 87, on: true }],
  };

  assert.equal(isWledState(state), true);
  assert.equal(extractWledState(state), state);
  assert.equal(extractWledState({ state }), state);
  assert.equal(extractWledState({ info: {} }), undefined);
});

test("presets may not move the protected segment boundaries", () => {
  const state = {
    on: true,
    bri: 255,
    seg: [
      { id: 0, start: 0, stop: 87, on: true },
      { id: 1, start: 88, stop: 174, on: true },
      { id: 2, start: 175, stop: 262, on: true },
    ],
  };
  const [safePreset] = parsePresets({
    1: {
      n: "Warm wit",
      seg: [
        { id: 0, start: 0, stop: 87 },
        { id: 1, start: 88, stop: 174 },
        { id: 2, start: 175, stop: 262 },
        { stop: 0 },
      ],
    },
  });
  const [unsafePreset] = parsePresets({
    9: {
      n: "Onveilig",
      seg: [{ id: 0, start: 0, stop: 88 }],
    },
  });

  assert.equal(isPresetSafe(safePreset, state), true);
  assert.equal(isPresetSafe(unsafePreset, state), false);
});
