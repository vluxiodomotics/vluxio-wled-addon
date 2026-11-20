import assert from "node:assert/strict";
import test from "node:test";
import { AddOn } from "@busch-jaeger/free-at-home";
import { configuredControllers, migrateLegacyPrimaryIp, migrateLegacySecondController, parseConfiguration } from "../config";

test("native multiple controller entries activate only configured controllers and preserve removal", () => {
  const raw = {
    controller1: { items: { wledIp: "192.0.2.20" } },
    controllers: {
      abc: { items: { wledIp: "192.0.2.21", masterName: "Two", visiblePresetIds: "1,3" } },
      def: { items: { wledIp: "", masterName: "Unconfigured" } },
      ghi: { items: { wledIp: "192.0.2.22", $disabled: true } },
    },
  } as unknown as AddOn.Configuration;
  const controllers = configuredControllers(parseConfiguration(raw));
  assert.equal(controllers.length, 2);
  assert.equal(controllers[1].masterName, "Two");
  assert.deepEqual([...controllers[1].visiblePresetIds ?? []], [1, 3]);
  delete (raw.controllers as Record<string, unknown>).abc;
  assert.equal(configuredControllers(parseConfiguration(raw)).length, 1);
});

test("legacy second controller migrates without changing its address and does not reappear after removal", () => {
  const raw = {
    controller1: { items: { wledIp: "192.0.2.20" } },
    controller2: { items: { secondaryWledIp: "192.0.2.21", secondaryMasterName: "Old second" } },
  } as unknown as AddOn.Configuration;
  const migrated = migrateLegacySecondController(raw)!;
  assert.equal(configuredControllers(parseConfiguration(migrated))[1].masterName, "Old second");
  assert.equal(migrateLegacySecondController(migrated), undefined);
  delete (migrated.controllers as Record<string, unknown>)["legacy-controller-2"];
  assert.equal(configuredControllers(parseConfiguration(migrated)).length, 1);
});

test("preset configuration supports filters, ranges and optional gestures", () => {
  const config = parseConfiguration({
    presets: {
      items: {
        visiblePresetIds: "1, 4-6; 250 999 fout",
        createNavigationButtons: true,
      },
    },
    connection: {
      items: {
        wledMacAddress: "AA:BB:CC:DD:EE:FF",
        autoDiscoveryEnabled: "1",
        rediscoveryInterval: 240,
      },
    },
  } as unknown as AddOn.Configuration);

  assert.deepEqual(
    [...(config.visiblePresetIds ?? [])],
    [1, 4, 5, 6, 250],
  );
  assert.equal(config.createPresetNavigationButtons, true);
  assert.equal(config.wledMacAddress, "aabbccddeeff");
  assert.equal(config.autoDiscoveryEnabled, true);
  assert.equal(config.rediscoveryIntervalSeconds, 240);
});

test("blank preset filter exposes all named presets and keeps gesture disabled", () => {
  const config = parseConfiguration({
    presets: {
      items: {
        visiblePresetIds: "",
      },
    },
  } as unknown as AddOn.Configuration);

  assert.equal(config.visiblePresetIds, undefined);
  assert.equal(config.createPresetNavigationButtons, true);
  assert.equal(config.wledMacAddress, undefined);
  assert.equal(config.autoDiscoveryEnabled, true);
  assert.equal(config.rediscoveryIntervalSeconds, 180);
});

test("invalid preset filter is ignored instead of hiding every preset", () => {
  const config = parseConfiguration({
    presets: {
      items: {
        visiblePresetIds: "0 abc 999",
      },
    },
  } as unknown as AddOn.Configuration);

  assert.equal(config.visiblePresetIds, undefined);
});

test("three on presses can enable preset navigation", () => {
  const config = parseConfiguration({ presets: { items: {
    triplePressEnabled: true,
    triplePressWindowSeconds: 4,
  } } } as unknown as AddOn.Configuration);
  assert.equal(config.presetTriplePressEnabled, true);
  assert.equal(config.presetTriplePressWindowMs, 4_000);
});

test("controller groups keep their own preset and gesture settings", () => {
  const config = parseConfiguration({
    controller1: { items: { masterName: "Voor", wledIp: "192.168.1.10", visiblePresetIds: "1,3", multiPressCount: 4, triplePressEnabled: true } },
    controller2: { items: { secondaryMasterName: "Achter", secondaryWledIp: "192.168.1.11", secondaryVisiblePresetIds: "2,5", secondaryMultiPressCount: 2, secondaryMultiPressEnabled: true, secondaryCreatePreviousPresetButton: false } },
  } as unknown as AddOn.Configuration);
  const [first, second] = configuredControllers(config);
  assert.equal(first.masterName, "Voor");
  assert.equal(second.masterName, "Achter");
  assert.deepEqual([...first.visiblePresetIds ?? []], [1, 3]);
  assert.deepEqual([...second.visiblePresetIds ?? []], [2, 5]);
  assert.equal(first.presetTriplePressCount, 4);
  assert.equal(second.presetTriplePressCount, 2);
  assert.equal(second.createPreviousPresetButton, false);
});

test("optional second controller has its own address and device name", () => {
  const config = parseConfiguration({
    connection: { items: { wledIp: "192.168.1.50", secondaryWledIp: "192.168.1.51" } },
    devices: { items: { masterName: "Woonkamer", secondaryMasterName: "Slaapkamer" } },
  } as unknown as AddOn.Configuration);
  const controllers = configuredControllers(config);
  assert.equal(controllers.length, 2);
  assert.equal(controllers[0].wledIp, "192.168.1.50");
  assert.equal(controllers[1].wledIp, "192.168.1.51");
  assert.equal(controllers[1].masterName, "Slaapkamer");
});

test("second controller cannot point to the first controller", () => {
  const config = parseConfiguration({
    connection: { items: { wledIp: "192.168.1.50", secondaryWledIp: "192.168.1.50" } },
  } as unknown as AddOn.Configuration);
  assert.throws(() => configuredControllers(config), /hetzelfde IP-adres/);
});

test("legacy first IP survives a new controller group with its default address", () => {
  const raw = {
    connection: { items: { wledIp: "192.0.2.36" } },
    controller1: { items: { wledIp: "192.168.1.50" } },
  } as unknown as AddOn.Configuration;
  const config = parseConfiguration(raw);
  assert.equal(config.wledIp, "192.0.2.36");
  const migrated = migrateLegacyPrimaryIp(raw);
  assert.equal((migrated?.controller1 as { items: { wledIp: string } })?.items.wledIp, "192.0.2.36");
  assert.equal(migrateLegacyPrimaryIp(migrated!), undefined);
});

test("blank second controller stays disabled and invalid address is rejected", () => {
  const blank = parseConfiguration({ controller2: { items: { secondaryWledIp: "" } } } as unknown as AddOn.Configuration);
  assert.equal(configuredControllers(blank).length, 1);
  const invalid = parseConfiguration({ controller2: { items: { secondaryWledIp: "not-an-ip" } } } as unknown as AddOn.Configuration);
  assert.throws(() => configuredControllers(invalid), /ongeldig/);
});

test("next and previous preset buttons can be selected separately", () => {
  const config = parseConfiguration({ presets: { items: {
    createNavigationButtons: true,
    createNextPresetButton: true,
    createPreviousPresetButton: false,
  } } } as unknown as AddOn.Configuration);
  assert.equal(config.createNextPresetButton, true);
  assert.equal(config.createPreviousPresetButton, false);
});

