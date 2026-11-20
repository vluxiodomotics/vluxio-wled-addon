import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import {
  brightnessByteToPercent,
  brightnessPercentToByte,
  WledClient,
} from "../wled/WledClient";
import { WledState } from "../wled/types";

test("WledClient reads discovery data and sends safe MVP commands", async () => {
  let state: WledState = {
    on: true,
    bri: 255,
    ps: 1,
    seg: [
      { id: 0, start: 0, stop: 87, on: true },
      { id: 1, start: 88, stop: 174, on: true },
      { id: 2, start: 175, stop: 262, on: true },
    ],
  };
  const postedBodies: unknown[] = [];
  let brightnessResponseDelayMs = 0;

  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/json/info") {
      return json(response, {
        ver: "16.0.0",
        brand: "QuinLED",
        product: "Dig-Quad-V3",
        mac: "AABBCCDDEEFF",
      });
    }
    if (request.method === "GET" && request.url === "/json/state") {
      return json(response, state);
    }
    if (request.method === "GET" && request.url === "/presets.json") {
      return json(response, {
        1: { n: "Warm wit" },
        4: { n: "1 op 10" },
        5: { n: "Vasteloavendj" },
      });
    }
    if (request.method === "POST" && request.url === "/json/state") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          on?: boolean;
          bri?: number;
          ps?: number;
          seg?: Array<{ id: number; on: boolean }>;
        };
        postedBodies.push(body);
        const stateBeforeCommand = state;
        if (typeof body.on === "boolean") {
          state = { ...state, on: body.on };
        }
        if (typeof body.bri === "number") {
          state = { ...state, bri: body.bri };
        }
        if (typeof body.ps === "number") {
          state = { ...state, on: true, ps: body.ps };
        }
        if (body.seg) {
          state = {
            ...state,
            on: body.on ?? state.on,
            seg: state.seg.map((segment) => {
              const update = body.seg?.find(
                (candidate) => candidate.id === segment.id,
              );
              return update ? { ...segment, on: update.on } : segment;
            }),
          };
        }
        // Actual WLED may return the old preset in its POST response even
        // though a subsequent GET already reports the new one.
        const sendResponse = () => json(response,
          typeof body.ps === "number" ? stateBeforeCommand : state);
        if (
          typeof body.bri === "number" &&
          brightnessResponseDelayMs > 0
        ) {
          setTimeout(sendResponse, brightnessResponseDelayMs);
        } else {
          sendResponse();
        }
      });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const client = new WledClient({
    ipAddress: `127.0.0.1:${address.port}`,
    pollIntervalMs: 60_000,
    commandDebounceMs: 5,
    enableWebSocket: false,
  });

  try {
    const snapshot = await client.start();
    assert.equal(snapshot.info.product, "Dig-Quad-V3");
    assert.deepEqual(
      snapshot.presets.map((preset) => preset.id),
      [1, 4, 5],
    );

    await client.setMasterOn(false);
    await client.setSegmentOn(1, true);
    const appliedPresetState = await client.applyPreset(5);
    assert.equal(appliedPresetState.ps, 5);
    await client.setBrightnessPercent(40);
    await client.setBrightnessPercent(1, 1);
    await client.setBrightnessPercent(0);

    assert.deepEqual(postedBodies, [
      { on: false, v: true },
      { seg: [{ id: 1, on: true }], v: true, on: true },
      { ps: 5, v: true },
      { on: true, bri: 102, v: true },
      { on: true, bri: 3, tt: 1, v: true },
      { on: false, v: true },
    ]);

    const ranges = client
      .getLastState()
      ?.seg.map((segment) => [segment.start, segment.stop]);
    assert.deepEqual(ranges, [
      [0, 87],
      [88, 174],
      [175, 262],
    ]);

    postedBodies.length = 0;
    brightnessResponseDelayMs = 100;
    const firstSlowWrite = client.setBrightnessPercent(90, 1);
    await wait(15);
    const supersededWrites = [
      client.setBrightnessPercent(80, 1),
      client.setBrightnessPercent(60, 1),
      client.setBrightnessPercent(40, 1),
      client.setBrightnessPercent(10, 1),
    ];
    await Promise.all([firstSlowWrite, ...supersededWrites]);

    assert.deepEqual(postedBodies, [
      { on: true, bri: 230, tt: 1, v: true },
      { on: true, bri: 26, tt: 1, v: true },
    ]);

    postedBodies.length = 0;
    const brightnessBeforeOff = client.setBrightnessPercent(90, 1);
    await wait(15);
    const supersededByOff = client.setBrightnessPercent(10, 1);
    const offCommand = client.setMasterOn(false);
    await Promise.all([brightnessBeforeOff, supersededByOff, offCommand]);

    assert.deepEqual(postedBodies, [
      { on: true, bri: 230, tt: 1, v: true },
      { on: false, v: true },
    ]);
  } finally {
    client.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("brightness conversion covers the complete free@home and WLED ranges", () => {
  assert.equal(brightnessPercentToByte(0), 0);
  assert.equal(brightnessPercentToByte(0.4), 1);
  assert.equal(brightnessPercentToByte(1), 3);
  assert.equal(brightnessPercentToByte(1.5), 4);
  assert.equal(brightnessPercentToByte(40), 102);
  assert.equal(brightnessPercentToByte(100), 255);
  assert.equal(brightnessPercentToByte(150), 255);

  assert.equal(brightnessByteToPercent(0), 0);
  assert.equal(brightnessByteToPercent(102), 40);
  assert.equal(brightnessByteToPercent(255), 100);
});

function json(response: http.ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
