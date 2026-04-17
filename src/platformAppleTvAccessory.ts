import type { PlatformAccessory } from "homebridge";

import { AppleTvDetector, type AppleTvStateChange } from "./appletv/appleTvDetector.js";
import type { AppleTvPowerStatePlatform } from "./platform.js";

export class PlatformAppleTvAccessory {
  constructor(
    private readonly platform: AppleTvPowerStatePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        "Homebridge Apple TV Powerstate by @rvetere",
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Apple TV")
      .setCharacteristic(this.platform.Characteristic.SerialNumber, "📺");

    const motionSensorPowerState =
      this.accessory.getService("Apple TV Powerstate") ||
      this.accessory.addService(
        this.platform.Service.MotionSensor,
        "Apple TV Powerstate",
        "📺",
      );

    const device = this.accessory.context.device;
    const detector = new AppleTvDetector(
      device.ip,
      device.credentials,
      (device.debounceDuration || 5) * 1000,
      this.platform.log,
    );

    detector.on("stateChange", ({ isPoweredOn }: AppleTvStateChange) => {
      motionSensorPowerState.updateCharacteristic(
        this.platform.Characteristic.MotionDetected,
        isPoweredOn,
      );

      this.platform.log.debug(
        `Apple TV power state for ${device.name}: ${isPoweredOn ? "On" : "Off"}`,
      );
    });

    detector.start();
  }
}
