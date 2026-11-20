import { AddOn, FreeAtHome } from "@busch-jaeger/free-at-home";
import { WledFreeAtHomeBridge } from "./bridge";
import { configuredControllers, migrateLegacyPrimaryIp, migrateLegacySecondController, parseConfiguration, WledAddonConfig } from "./config";
import { WledClient } from "./wled/WledClient";

interface ActiveRuntime {
  bridge: WledFreeAtHomeBridge;
  freeAtHome: FreeAtHome;
}

interface AddOnButtonEvent {
  eventType?: string;
  group?: string;
  parameter?: string;
}

const metadata = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metadata.id);

const runtimes = new Map<string, ActiveRuntime>();
let retryTimer: NodeJS.Timeout | undefined;
let currentConfig: WledAddonConfig | undefined;
let configurationQueue: Promise<void> = Promise.resolve();
let shuttingDown = false;

addOn.on("configurationChanged", (configuration: AddOn.Configuration) => {
  configurationQueue = configurationQueue
    .then(async () => {
      const primary = migrateLegacyPrimaryIp(configuration) ?? configuration;
      const migrated = migrateLegacySecondController(primary) ?? (primary !== configuration ? primary : undefined);
      if (migrated) {
        await addOn.setConfiguration(migrated);
        console.log("Oud WLED-IP-adres overgenomen in de instellingen van controller 1.");
      }
      await configure(parseConfiguration(migrated ?? configuration));
    })
    .catch((error: unknown) => {
      console.error(`Configuration failed: ${toError(error).message}`);
    });
});

addOn.on("event", (event: AddOnButtonEvent) => {
  configurationQueue = configurationQueue
    .then(() => handleEvent(event))
    .catch((error: unknown) => {
      console.error(`Event failed: ${toError(error).message}`);
    });
});

addOn.connectToConfiguration();
addOn.connectToEvents();

process.on("unhandledRejection", (reason: unknown) => {
  console.error(`Onverwerkte fout: ${toError(reason).message}`);
});

process.on("uncaughtException", (error: Error) => {
  console.error(`Onverwachte fout: ${error.message}`);
});

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

async function configure(config: WledAddonConfig): Promise<void> {
  const nextControllers = configuredControllers(config);
  const nextKeys = new Set(nextControllers.map((controller) => controller.controllerKey ?? controller.wledIp));
  currentConfig = config;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  for (const [key, active] of runtimes) {
    await stopRuntime(active, !nextKeys.has(key));
  }
  runtimes.clear();
  for (const controller of nextControllers) {
    await startRuntime(controller);
  }
}

async function startRuntime(config: WledAddonConfig): Promise<void> {
  if (shuttingDown) {
    return;
  }

  const freeAtHome = new FreeAtHome();
  freeAtHome.setEnableLogging(true);
  const wled = new WledClient({
    ipAddress: config.wledIp,
    pollIntervalMs: config.pollIntervalSeconds * 1_000,
    autoDiscovery: config.autoDiscoveryEnabled,
    rediscoveryIntervalMs: config.rediscoveryIntervalSeconds * 1_000,
    expectedMac: config.wledMacAddress,
  });
  const bridge = new WledFreeAtHomeBridge(
    freeAtHome,
    wled,
    config,
    console,
  );

  try {
    await bridge.start();
    runtimes.set(config.controllerKey ?? config.wledIp, { bridge, freeAtHome });
    console.log(`WLED-add-on actief voor ${config.wledIp}`);
  } catch (error) {
    await bridge.stop();
    freeAtHome.disconnectFreeAtHomeApi();
    console.error(
      `Starting WLED ${config.wledIp} failed: ${toError(error).message}`,
    );
    scheduleRetry();
  }
}

function scheduleRetry(): void {
  if (shuttingDown || retryTimer) {
    return;
  }

  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    const retryConfig = currentConfig;
    if (!retryConfig) {
      return;
    }
    configurationQueue = configurationQueue
      .then(async () => {
        if (
          !shuttingDown &&
          runtimes.size < configuredControllers(retryConfig).length &&
          currentConfig === retryConfig
        ) {
          for (const controller of configuredControllers(retryConfig)) {
            if (!runtimes.has(controller.controllerKey ?? controller.wledIp)) await startRuntime(controller);
          }
        }
      })
      .catch((error: unknown) => {
        console.error(`Restart failed: ${toError(error).message}`);
      });
  }, 15_000);
}

async function stopRuntime(
  activeRuntime: ActiveRuntime,
  removeVirtualDevices = false,
): Promise<void> {
  await activeRuntime.bridge.stop({ removeVirtualDevices });
  activeRuntime.freeAtHome.disconnectFreeAtHomeApi();
}

async function stopAllRuntimes(removeVirtualDevices = false): Promise<void> {
  for (const active of runtimes.values()) await stopRuntime(active, removeVirtualDevices);
  runtimes.clear();
}

async function handleEvent(event: AddOnButtonEvent): Promise<void> {
  if (event.eventType !== "buttonPressed" || event.group !== "advanced") {
    return;
  }

  if (event.parameter === "initializeVirtualDevices") await initializeVirtualDevices();
}

async function initializeVirtualDevices(): Promise<void> {
  const config = currentConfig;
  if (!config) {
    console.log("Geen configuratie beschikbaar om de WLED-verbinding te herstarten.");
    return;
  }

  if (runtimes.size) {
    await stopAllRuntimes();
  }

  for (const controller of configuredControllers(config)) {
    await startRuntime(controller);
  }
  console.log("WLED-verbinding herstart; bestaande virtuele apparaten behouden.");
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  await stopAllRuntimes();

  addOn.dispose();
  process.exitCode = 0;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
