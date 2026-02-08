# Fairphone Fairbuds BLE Protocol (QXW)

This document describes the proprietary BLE protocol used by the Fairphone Fairbuds, reverse-engineered from the
official Android app (`EarbudsConnectionManager.java`, `Commands.java`). It is intended as a reference for
reimplementation using the Web Bluetooth API.

---

## 1. BLE Connection

### 1.1 GATT Service & Characteristics

The Fairbuds expose a custom GATT service:

| Role          | UUID                                   |
|---------------|----------------------------------------|
| **Service**   | `0000ff12-0000-1000-8000-00805f9b34fb` |
| **Notify**    | `0000ff13-0000-1000-8000-00805f9b34fb` |
| **Write**     | `0000ff14-0000-1000-8000-00805f9b34fb` |

There is also an alternative custom service whose purpose is unknown:

| Role          | UUID                                   |
|---------------|----------------------------------------|
| Service       | `66666666-6666-6666-6666-666666666666` |
| Characteristic| `77777777-7777-7777-7777-777777777777` |

### 1.2 Connection Sequence

1. **Scan & Connect** — Use `navigator.bluetooth.requestDevice()` with a `namePrefix` filter for `"Fairbuds"` and
  `serviceData` entries for the service, notify, and write UUIDs.
2. **Connect to GATT Server** — `device.gatt.connect()`.
3. **Get the Service** — `server.getPrimaryService('0000ff12-0000-1000-8000-00805f9b34fb')`.
4. **Get Characteristics**:
   - **Write characteristic** (`0000ff14-...`) — used to send commands. Write using `characteristic.writeValueWithoutResponse(data)` (the Python implementation uses `write_gatt_char(..., response=False)`).
   - **Notify characteristic** (`0000ff13-...`) — used to receive responses. Subscribe via `characteristic.startNotifications()` and listen to `characteristicvaluechanged` events.
5. **Request Device Info** — After subscribing to notifications, send the device info command (see §3) to confirm the connection is working and retrieve battery/device data.

### 1.3 Disconnection

1. Stop notifications on the notify characteristic.
2. Wait ~300ms.
3. Disconnect from the GATT server.
4. Wait ~500ms before attempting reconnection if needed.

---

## 2. QXW Packet Format

All commands and responses use the **QXW** framing protocol.

### 2.1 General Structure

```
┌─────────┬─────────┬──────┬────────┬───────────┐
│ Header  │ Command │ Type │ Length │  Payload  │
│ 3 bytes │ 1 byte  │ 1 byte│ 1 byte│ N bytes  │
└─────────┴─────────┴──────┴────────┴───────────┘
```

- **Header**: Always `0x51 0x58 0x57` (ASCII `"QXW"`).
- **Command**: Identifies the operation (see §2.2).
- **Type**: Direction/intent of the packet (see §2.3).
- **Length**: Number of payload bytes that follow.
- **Payload**: Command-specific data.

### 2.2 Command Codes

| Code   | Name             | Description                        |
|--------|------------------|------------------------------------|
| `0x10` | `CMD_SELECT_EQ`  | Select a built-in EQ preset       |
| `0x20` | `CMD_CUSTOM_EQ`  | Set custom EQ band parameters     |
| `0x27` | `CMD_DEVICE_INFO`| Request device info (battery etc.) |

### 2.3 Type Codes

| Code   | Name           | Usage                              |
|--------|----------------|------------------------------------|
| `0x01` | `TYPE_REQUEST` | Sent from host → earbuds (request) |
| `0x03` | `TYPE_NOTIFY`  | Sent from earbuds → host, or used for custom EQ commands |

### 2.4 Notification Parsing

All incoming data on the notify characteristic should be checked for the `QXW` prefix (`0x515857`). After stripping the 3-byte header, the next byte is the command code:

- `0x27` — Device info notification. Sub-code `0x02` follows (i.e., bytes `27 02` after prefix). Parse payload per §3.
- `0x10` — Preset change confirmation (no payload to parse).
- `0x20` — Custom EQ confirmation (no payload to parse).

---

## 3. Battery / Device Info

### 3.1 Request

Send a device info request:

```
QXW  CMD   TYPE  LEN
51   58 57  27    01   00
```

Hex bytes: `515857 27 01 00`

- Command: `0x27` (`CMD_DEVICE_INFO`)
- Type: `0x01` (`TYPE_REQUEST`)
- Length: `0x00` (no payload)

### 3.2 Response

The earbuds respond with a notification on the notify characteristic:

```
51 58 57  27 02  <payload...>
```

After stripping the QXW prefix (`515857`) and the command+sub-code (`2702`), the remaining payload is parsed as follows:

#### Battery Data (first 5 bytes of remaining payload)

Split the first 10 hex characters (5 bytes) into 2-char chunks:

```
Byte 0: unknown
Byte 1: unknown
Byte 2: battery_left  (0–100, percentage)
Byte 3: battery_right (0–100, percentage)
Byte 4: unknown
```

**Example**: Payload starts with `0103646400` → chunks `['01', '03', '64', '64', '00']`
- `battery_left  = 0x64 = 100%`
- `battery_right = 0x64 = 100%`

#### Device Name (at end of payload)

The device name is stored as a length-prefixed ASCII string somewhere near the end of the payload. To extract it, scan backwards from the end of the payload bytes:

1. Read byte at position `i` as `name_len`.
2. If `name_len > 0` and `name_len < 32`, try to decode the next `name_len` bytes as ASCII.
3. If the result is printable, that's the device name.

---

## 4. EQ Presets

### 4.1 Available Presets

| Preset Number | Name        |
|---------------|-------------|
| 1             | Main        |
| 2             | Bass boost  |
| 3             | Flat        |
| 4             | Studio      |

> **Note**: "Studio" (preset 4) is the preset used as a base when applying custom EQ on top.

### 4.2 Set Preset Command

```
QXW  CMD   TYPE  LEN  PAYLOAD
51   58 57  10    01   01   <preset>
```

Hex bytes: `515857 10 01 01 PP`

- Command: `0x10` (`CMD_SELECT_EQ`)
- Type: `0x01` (`TYPE_REQUEST`)
- Length: `0x01`
- Payload: 1 byte — the preset number (`0x01`–`0x04`)

**Example** — Set "Bass boost" (preset 2): `515857 10 01 01 02`

---

## 5. Custom EQ

### 5.1 Band Configuration

The Fairbuds have **8 fixed EQ bands** at these center frequencies:

| Band Index | Frequency (Hz) |
|------------|-----------------|
| 0          | 60              |
| 1          | 100             |
| 2          | 230             |
| 3          | 500             |
| 4          | 1100            |
| 5          | 2400            |
| 6          | 5400            |
| 7          | 12000           |

### 5.2 Gain Encoding

Gain is encoded as a single byte using the formula:

```
encoded = (gain_dB × 10) + 120
```

To decode:

```
gain_dB = (encoded - 120) / 10
```

| Gain (dB) | Encoded Byte |
|-----------|-------------|
| -12.0     | 0           |
| -10.0     | 20          |
| 0.0       | 120         |
| +6.0      | 180         |
| +10.0     | 220         |
| +13.5     | 255         |

Valid range: `0`–`255` (corresponding to `-12.0 dB` to `+13.5 dB`).

### 5.3 Q-Factor Encoding

The Q-factor (filter bandwidth) is encoded as a single byte:

```
encoded = Q_real × 10
```

To decode:

```
Q_real = encoded / 10
```

| Q Real | Encoded Byte |
|--------|-------------|
| 0.7    | 7 (default) |
| 1.0    | 10          |
| 3.0    | 30          |

The default Q-factor byte value is **7** (Q = 0.7). Valid range: `0`–`255`.

### 5.4 Set Custom EQ Command

The custom EQ command sends all bands at once. Each band is encoded as 3 bytes:

```
<band_index> <gain_encoded> <q_encoded>
```

Full packet:

```
QXW  CMD   TYPE  LEN          BAND DATA
51   58 57  20    03   <len>   [<band> <gain> <q>] × N
```

- Command: `0x20` (`CMD_CUSTOM_EQ`)
- Type: `0x03` (`TYPE_NOTIFY`) — note: custom EQ uses type `0x03`, not `0x01`
- Length: `N × 3` (3 bytes per band, so `24` = `0x18` for all 8 bands)
- Payload: Repeated `[band_index, gain_encoded, q_encoded]` triplets

**Example** — Set all 8 bands to 0 dB with default Q (0.7):

```
515857 20 03 18
  00 78 07    ← Band 0: 60Hz,    0.0dB, Q=0.7
  01 78 07    ← Band 1: 100Hz,   0.0dB, Q=0.7
  02 78 07    ← Band 2: 230Hz,   0.0dB, Q=0.7
  03 78 07    ← Band 3: 500Hz,   0.0dB, Q=0.7
  04 78 07    ← Band 4: 1100Hz,  0.0dB, Q=0.7
  05 78 07    ← Band 5: 2400Hz,  0.0dB, Q=0.7
  06 78 07    ← Band 6: 5400Hz,  0.0dB, Q=0.7
  07 78 07    ← Band 7: 12000Hz, 0.0dB, Q=0.7
```

(`0x78` = 120 decimal = 0.0 dB; `0x07` = 7 = Q 0.7)

**Example** — Set band 0 (60Hz) to +6.0 dB, all others flat:

```
515857 20 03 18
  00 B4 07    ← Band 0: 60Hz,  +6.0dB, Q=0.7   (0xB4 = 180)
  01 78 07    ← Band 1: 100Hz,  0.0dB, Q=0.7
  02 78 07    ← Band 2: 230Hz,  0.0dB, Q=0.7
  03 78 07    ← Band 3: 500Hz,  0.0dB, Q=0.7
  04 78 07    ← Band 4: 1100Hz, 0.0dB, Q=0.7
  05 78 07    ← Band 5: 2400Hz, 0.0dB, Q=0.7
  06 78 07    ← Band 6: 5400Hz, 0.0dB, Q=0.7
  07 78 07    ← Band 7: 12000Hz,0.0dB, Q=0.7
```

> **Important**: The protocol requires sending **all bands** in a single command, even if only one band changed. Track the current state of all bands client-side and re-send the full set on every change.

---

## 6. Timing & Reliability

- **Write method**: Use write-without-response (`writeValueWithoutResponse` in Web Bluetooth).
- **Response timeout**: Wait up to **5 seconds** for a notification response after sending a command.
- **Post-command delay**: Wait **300ms** after each command to allow the DSP to apply changes.
- **Reconnection delay**: After disconnecting, wait **500ms** before attempting to reconnect. After calling `disconnect()`, wait **2 seconds** before a full reconnection attempt.

---

## 7. Web Bluetooth API Mapping Summary

| Python (Bleak)                                       | Web Bluetooth API                                                              |
|------------------------------------------------------|--------------------------------------------------------------------------------|
| `BleakScanner.discover()`                            | `navigator.bluetooth.requestDevice({filters: [...]}, optionalServices: [...])` |
| `BleakClient(address)`                               | `device.gatt.connect()`                                                        |
| `client.services`                                    | `server.getPrimaryService(uuid)`                                               |
| `client.start_notify(uuid, handler)`                 | `characteristic.startNotifications()` + `addEventListener`                     |
| `client.write_gatt_char(uuid, data, response=False)` | `characteristic.writeValueWithoutResponse(data)`                               |
| `client.read_gatt_char(uuid)`                        | `characteristic.readValue()`                                                   |
| `client.stop_notify(uuid)`                           | `characteristic.stopNotifications()`                                           |
| `client.disconnect()`                                | `device.gatt.disconnect()`                                                     |

### Web Bluetooth `requestDevice` Filter

```javascript
const device = await navigator.bluetooth.requestDevice({
  filters: [
    {
      namePrefix: "Fairbuds",
      serviceData: [
        { service: "0000ff12-0000-1000-8000-00805f9b34fb" },
        { service: "0000ff13-0000-1000-8000-00805f9b34fb" },
        { service: "0000ff14-0000-1000-8000-00805f9b34fb" },
      ],
    },
  ],
  // Setting optional services is required to get permission to use the primary service.
  optionalServices: ["0000ff12-0000-1000-8000-00805f9b34fb"],
});
```
