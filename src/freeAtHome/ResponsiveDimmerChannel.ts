import { EventEmitter } from "node:events";
import {
  Datapoint,
  FreeAtHomeRawChannel,
  PairingIds,
} from "@busch-jaeger/free-at-home";

const RELATIVE_INTERVAL_MS = 50;
const PERCEPTUAL_GAMMA = 2;

interface ResponsiveDimmerOptions {
  fullRangeDurationMs: number;
  minimumBrightnessPercent: number;
  logger?: Pick<Console, "warn">;
}

export class ResponsiveDimmerChannel extends EventEmitter {
  private readonly relativePositionStep: number;
  private readonly minimumBrightness: number;
  private readonly logger: Pick<Console, "warn">;
  private relativeTimer?: NodeJS.Timeout;
  private relativeDimmingActive = false;
  private relativeButtonHeld = false;
  private relativeDimmingSuppressed = false;
  private currentBrightness = 100;
  private latestFeedbackBrightness = 100;

  private readonly datapointListener = (id: PairingIds, value: string) => {
    this.handleDatapoint(id, value);
  };
  private readonly sceneListener = (scene: Datapoint[]) => {
    this.handleScene(scene);
  };

  public constructor(
    private readonly rawChannel: FreeAtHomeRawChannel,
    options: ResponsiveDimmerOptions,
  ) {
    super();
    const duration = Math.max(500, options.fullRangeDurationMs);
    this.relativePositionStep = RELATIVE_INTERVAL_MS / duration;
    this.minimumBrightness = Math.max(
      1,
      Math.min(20, normalizePercentage(options.minimumBrightnessPercent)),
    );
    this.logger = options.logger ?? console;

    rawChannel.on("datapointChanged", this.datapointListener);
    rawChannel.on("sceneTriggered", this.sceneListener);
  }

  public setAutoKeepAlive(value: boolean): void {
    this.rawChannel.setAutoKeepAlive(value);
  }

  public async setUnresponsive(): Promise<void> {
    await this.rawChannel.setUnresponsive();
  }

  public async destroy(): Promise<void> {
    this.dispose();
    await this.rawChannel.destroy();
  }

  public async triggerKeepAlive(): Promise<void> {
    await this.rawChannel.triggerKeepAlive();
  }

  public setOnOff(isOn: boolean): void {
    this.writeFeedback(
      PairingIds.AL_INFO_ON_OFF,
      isOn ? "1" : "0",
    );
  }

  public setValue(percentage: number): void {
    const normalized = normalizePercentage(percentage);
    this.latestFeedbackBrightness = normalized;
    // WLED can report an older transition value while a relative dim command
    // is still in progress. Keep the local target monotonic until the button
    // is released, otherwise those delayed reports make the next step jump
    // backwards.
    if (!this.relativeButtonHeld) {
      this.currentBrightness = normalized;
    }
    this.writeFeedback(
      PairingIds.AL_INFO_ACTUAL_DIMMING_VALUE,
      normalized.toString(),
    );
  }

  public setRelativeDimmingSuppressed(value: boolean): void {
    this.relativeDimmingSuppressed = value;
    if (value) {
      this.stopRelativeDimming();
    }
  }

  public dispose(): void {
    this.finishRelativePress();
    this.rawChannel.off("datapointChanged", this.datapointListener);
    this.rawChannel.off("sceneTriggered", this.sceneListener);
    this.removeAllListeners();
  }

  private handleDatapoint(id: PairingIds, value: string): void {
    switch (id) {
      case PairingIds.AL_SWITCH_ON_OFF:
        this.finishRelativePress();
        this.emit("isOnChanged", value === "1");
        break;

      case PairingIds.AL_ABSOLUTE_SET_VALUE_CONTROL:
        this.finishRelativePress();
        this.emitAbsoluteValue(value);
        break;

      case PairingIds.AL_RELATIVE_SET_VALUE_CONTROL:
        this.handleRelativeValue(value);
        break;

      case PairingIds.AL_FORCED: {
        const forcedValue = Number.parseInt(value, 10);
        if (Number.isInteger(forcedValue)) {
          this.emit("isOnChanged", (forcedValue & 1) === 1);
        }
        break;
      }
    }
  }

  private handleRelativeValue(value: string): void {
    switch (value) {
      case "15":
        this.emit("relativeStepRequested", 1);
        this.applyRelativeStep(1);
        break;
      case "7":
        this.emit("relativeStepRequested", -1);
        this.applyRelativeStep(-1);
        break;
      case "9":
        this.startRelativeDimming(1);
        break;
      case "1":
        this.startRelativeDimming(-1);
        break;
      case "8":
      case "0":
        this.finishRelativePress();
        break;
    }
  }

  private startRelativeDimming(direction: 1 | -1): void {
    if (this.relativeButtonHeld) {
      return;
    }

    this.stopRelativeDimming();
    this.relativeButtonHeld = true;
    this.relativeDimmingActive = true;
    this.emit("relativePressStarted", direction);
    this.applyRelativeStep(direction);
    if (!this.relativeDimmingActive) {
      return;
    }
    this.relativeTimer = setInterval(() => {
      this.applyRelativeStep(direction);
    }, RELATIVE_INTERVAL_MS);
  }

  private stopRelativeDimming(): void {
    this.relativeDimmingActive = false;
    if (this.relativeTimer) {
      clearInterval(this.relativeTimer);
      this.relativeTimer = undefined;
    }
  }

  private finishRelativePress(): void {
    const wasHeld = this.relativeButtonHeld;
    this.relativeButtonHeld = false;
    this.stopRelativeDimming();
    this.currentBrightness = this.latestFeedbackBrightness;
    if (wasHeld) {
      this.emit("relativePressStopped");
    }
  }

  private applyRelativeStep(direction: 1 | -1): void {
    if (this.relativeDimmingSuppressed) {
      this.stopRelativeDimming();
      return;
    }

    const previousTarget = clampPercentage(this.currentBrightness);
    if (direction < 0 && previousTarget <= this.minimumBrightness) {
      this.currentBrightness = this.minimumBrightness;
      this.stopRelativeDimming();
      return;
    }
    if (direction > 0 && previousTarget >= 100) {
      this.currentBrightness = 100;
      this.stopRelativeDimming();
      return;
    }

    if (direction > 0 && previousTarget < this.minimumBrightness) {
      this.currentBrightness = this.minimumBrightness;
      this.emit(
        "absoluteValueChanged",
        this.minimumBrightness,
        "relative",
      );
      return;
    }

    const minimumPosition = brightnessToPerceptualPosition(
      this.minimumBrightness,
    );
    const previousPosition = brightnessToPerceptualPosition(previousTarget);
    const nextPosition = Math.max(
      minimumPosition,
      Math.min(
        1,
        previousPosition + direction * this.relativePositionStep,
      ),
    );
    const nextTarget =
      nextPosition <= minimumPosition
        ? this.minimumBrightness
        : nextPosition >= 1
          ? 100
          : perceptualPositionToBrightness(nextPosition);
    if (Math.abs(nextTarget - previousTarget) < Number.EPSILON) {
      this.stopRelativeDimming();
      return;
    }

    this.currentBrightness = nextTarget;
    if (
      brightnessToWledLevel(nextTarget) !==
      brightnessToWledLevel(previousTarget)
    ) {
      this.emit("absoluteValueChanged", nextTarget, "relative");
    }

    if (
      nextTarget <= this.minimumBrightness ||
      nextTarget >= 100
    ) {
      this.stopRelativeDimming();
    }
  }

  private emitAbsoluteValue(value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }

    this.currentBrightness = normalizePercentage(parsed);
    this.emit("absoluteValueChanged", this.currentBrightness, "absolute");
  }

  private handleScene(scene: Datapoint[]): void {
    const brightness = scene.find(
      (datapoint) =>
        datapoint.pairingID === PairingIds.AL_INFO_ACTUAL_DIMMING_VALUE,
    );
    if (brightness) {
      this.emitAbsoluteValue(brightness.value);
    }
  }

  private writeFeedback(id: PairingIds, value: string): void {
    void this.rawChannel.setOutputDatapoint(id, value).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Dimmer feedback failed: ${message}`);
    });
  }
}

function normalizePercentage(value: number): number {
  return Math.round(clampPercentage(value));
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function brightnessToPerceptualPosition(brightness: number): number {
  return Math.pow(clampPercentage(brightness) / 100, 1 / PERCEPTUAL_GAMMA);
}

function perceptualPositionToBrightness(position: number): number {
  return 100 * Math.pow(Math.max(0, Math.min(1, position)), PERCEPTUAL_GAMMA);
}

function brightnessToWledLevel(brightness: number): number {
  return Math.round((clampPercentage(brightness) * 255) / 100);
}
