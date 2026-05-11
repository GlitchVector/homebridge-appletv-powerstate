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
      "debounceDuration": 1
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `name` | — | Accessory name in HomeKit |
| `ip` | — | Apple TV IP address |
| `credentials` | — | Companion credentials from pairing |
| `identifier` | — | Apple TV identifier (UUID-shaped). Optional; required for cross-VLAN setups, see below |
| `companionPort` | `49153` | Companion-protocol TCP port. Optional; only used together with `identifier` |
| `debounceDuration` | `1` | Seconds after a change during which flips are suppressed to filter transient flaps (min: 1) |

## Manual pairing (CLI)

```
atvremote scan
atvremote -s <ip> --protocol companion pair
```

## Cross-VLAN / different-subnet setups

By default the daemon runs `pyatv.scan(hosts=[ip])` before connecting. That call uses unicast mDNS, and most Apple TV mDNS responders **refuse off-link queries** (RFC 6762 link-local rule). If Homebridge runs on a different VLAN/subnet than the Apple TV — common with isolated wifi VLANs — the scan returns "no Apple TV found" even though `ping <ip>` works fine.

**Fix:** provide `identifier` (and optionally `companionPort`) in the device config. When both `identifier` and `credentials` are set, the daemon constructs the pyatv config directly and connects via Companion without ever calling `pyatv.scan` — bypassing the mDNS dependency entirely.

To get the identifier, run `atvremote scan` from a host that **is** on the same VLAN as the Apple TV (your phone/laptop on its wifi works). The output looks like:

```
Name: Livingroom
Address: 192.168.5.31
Identifiers:
 - 3A9926A3-228C-4C30-AA5C-A8E85495EC68      ← use this one (UUID-shaped, most stable)
 - 3A:99:26:A3:22:8C
Services:
 - Protocol: Companion, Port: 49153, Pairing: Mandatory
```

Then pair from the same host (`atvremote --id <identifier> pair --protocol companion`) and copy the printed credentials hex into the plugin config alongside the identifier.

## License

Apache-2.0
