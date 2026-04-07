# homebridge-appletv-powerstate

Homebridge plugin that detects the power state of an Apple TV using [pyatv](https://pyatv.dev/). Exposes a MotionSensor that triggers when the Apple TV is powered on -- useful for HomeKit automations (e.g. turning on lights when you start watching TV).

## Prerequisites

- [Homebridge](https://homebridge.io/) v1.8+ or v2.0+
- [pyatv](https://pyatv.dev/) installed and `atvremote` on your PATH:
  ```
  brew install pipx && pipx install pyatv
  ```

## Setup

1. Install the plugin via Homebridge UI or npm
2. Open the plugin settings in Homebridge UI
3. Click **Scan Network** to discover Apple TV devices
4. Click **Pair** next to your Apple TV and enter the PIN shown on screen
5. Click **Save to Config** -- done

## Configuration

```json
{
  "platform": "AppleTvPowerState",
  "devices": [
    {
      "name": "Projector",
      "ip": "192.168.1.31",
      "credentials": "<from pairing>",
      "pollingInterval": 3,
      "debounceDuration": 2
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `name` | — | Accessory name in HomeKit |
| `ip` | — | Apple TV IP address |
| `credentials` | — | Companion credentials from pairing |
| `pollingInterval` | `10` | Seconds between power state checks (min: 3) |
| `debounceDuration` | `5` | Seconds to confirm a state change (min: 1) |

## Manual pairing (CLI)

```
atvremote scan
atvremote -s <ip> --protocol companion pair
```

## License

Apache-2.0
