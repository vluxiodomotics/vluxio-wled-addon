import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  FreeAtHomeRawChannel,
  PairingIds,
} from "@busch-jaeger/free-at-home";
import { ResponsiveDimmerChannel } from "../freeAtHome/ResponsiveDimmerChannel";

class FakeRawDimmerChannel extends EventEmitter {
  public readonly outputs = new Map<PairingIds, string>();

  public setAutoKeepAlive(): void {}
  public async setUnresponsive(): Promise<void> {}
  public async triggerKeepAlive(): Promise<void> {}

  public async setOutputDatapoint(
    id: PairingIds,
    value: string,
  ): Promise<void> {
    this.outputs.set(id, value);
  }
}

test("feedback datapoints are not treated as new dim commands", () => {
  const raw = new FakeRawDimmerChannel();
  const channel = createChannel(raw);
  const commands: number[] = [];
  channel.on("absoluteValueChanged", (value: number) => commands.push(value));

  raw.emit(
    "datapointChanged",
    PairingIds.AL_INFO_ACTUAL_DIMMING_VALUE,
    "75",
  );

  assert.deepEqual(commands, []);
  channel.dispose();
});

test("delayed WLED feedback cannot reverse an active relative dim target", async () => {
  const raw = new FakeRawDimmerChannel();
  const channel = createChannel(raw);
  const commands: number[] = [];
  channel.on("absoluteValueChanged", (value: number) => commands.push(value));

  channel.setValue(50);
  raw.emit(
    "datapointChanged",
    PairingIds.AL_RELATIVE_SET_VALUE_CONTROL,
    "1",
  );
  assert.equal(commands.length, 1);
  assert.ok(commands[0] < 50);

  // Simulate an older WLED transition report arriving after the first command.
  channel.setValue(50);
  await wait(65);
  raw.emit(
    "datapointChanged",
    PairingIds.AL_RELATIVE_SET_VALUE_CONTROL,
    "0",
  );

  assert.equal(commands.length, 2);
  assert.ok(commands[1] < commands[0]);
  channel.dispose();
});

test("relative dimming stops at the configured minimum instead of switching off", async () => {
  const raw = new FakeRawDimmerChannel();
  const channel = createChannel(raw, 500);
  const commands: number[] = [];
  channel.on("absoluteValueChanged", (value: number) => commands.push(value));

  channel.setValue(4);
  raw.emit(
    "datapointChanged",
    PairingIds.AL_RELATIVE_SET_VALUE_CONTROL,
    "1",
  );
  await wait(80);

  assert.equal(commands.at(-1), 1);
  assert.ok(commands.every((value) => value >= 1));
  channel.dispose();
});

function createChannel(
  raw: FakeRawDimmerChannel,
  fullRangeDurationMs = 5_000,
): ResponsiveDimmerChannel {
  return new ResponsiveDimmerChannel(
    raw as unknown as FreeAtHomeRawChannel,
    {
      fullRangeDurationMs,
      minimumBrightnessPercent: 1,
    },
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
