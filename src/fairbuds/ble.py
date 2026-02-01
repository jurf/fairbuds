"""Low-level BLE communication for Fairbuds.

This module handles the raw BLE connection and QXW protocol encoding/decoding.
For high-level EQ control, use the FairbudsEQ class from the eq module.
"""

import asyncio
from typing import Optional

from bleak import BleakClient
from bleak.backends.characteristic import BleakGATTCharacteristic

from .protocol import (
    CMD_CUSTOM_EQ,
    CMD_DEVICE_INFO,
    CMD_SELECT_EQ,
    DEFAULT_Q,
    FAIRBUDS_NOTIFY_UUID,
    FAIRBUDS_SERVICE_UUID,
    FAIRBUDS_WRITE_UUID,
    GAIN_OFFSET,
    GAIN_SCALE,
    QXW_PREFIX,
    TYPE_NOTIFY,
    TYPE_REQUEST,
    DeviceInfo,
)
from .ui import dim, error, info, tprint, warning


class FairbudsBLE:
    """Fairbuds BLE protocol handler using QXW protocol.

    This class handles the low-level BLE communication:
    - Connection management
    - Notification handling
    - Command encoding and sending
    - Response parsing
    """

    def __init__(self, address: str) -> None:
        self.address = address
        self.client: Optional[BleakClient] = None
        self.response_data: Optional[bytes] = None
        self.response_event = asyncio.Event()
        self.write_char = FAIRBUDS_WRITE_UUID
        self.notify_char = FAIRBUDS_NOTIFY_UUID
        self.device_info: Optional[DeviceInfo] = None
        self.disconnected = False

    def _disconnected_callback(self, client: BleakClient) -> None:
        """Called when BLE disconnects unexpectedly."""
        self.disconnected = True
        tprint("")
        tprint("=" * 60)
        tprint(warning("⚠️  BLE DISCONNECTED!"))
        tprint("=" * 60)
        tprint("The earbuds disconnected (likely from Q-factor change).")
        tprint("Audio continues playing but BLE control is lost.")
        tprint("")
        tprint("To reconnect:")
        tprint("  1. Put earbuds in case, close lid, wait 5 sec")
        tprint("  2. Take them out and wear them")
        tprint("  3. Type 'reconnect' here")
        tprint("")
        tprint("Or type 'quit' to exit.")
        tprint("=" * 60)

    def _notification_handler(
        self, characteristic: BleakGATTCharacteristic, data: bytearray
    ) -> None:
        """Handle incoming notifications."""
        hex_data = data.hex()

        # Parse QXW protocol response
        if hex_data.startswith("515857"):
            payload = hex_data[6:]  # Remove "QXW" prefix
            cmd = payload[:2] if len(payload) >= 2 else ""

            # Device info notification (27 02 ...)
            if cmd == "27":
                if payload.startswith("2702"):
                    tprint(dim(f"  ← Received: {hex_data}"))
                    self._parse_device_info(payload[4:])
            # Preset change confirmation (10 ...)
            elif cmd == "10":
                # Suppress verbose output for preset confirmations
                pass
            # Custom EQ confirmation (20 ...)
            elif cmd == "20":
                # Suppress verbose output for EQ confirmations
                pass
            else:
                # Unknown command response
                tprint(dim(f"  ← Received: {hex_data}"))
        else:
            # Non-QXW response
            tprint(dim(f"  ← Received: {hex_data}"))

        self.response_data = bytes(data)
        self.response_event.set()

    def _parse_device_info(self, payload: str) -> None:
        """Parse device info notification.

        Based on Java implementation in EarbudsConnectionManager.java:
        Takes first 10 hex chars (5 bytes) after removing '2702' prefix,
        splits into 2-char chunks, battery is at index 2 and 3.

        Example: 0103646400... -> ['01', '03', '64', '64', '00']
        Battery left = 0x64 = 100%, Battery right = 0x64 = 100%

        Device name is at the end: length-prefixed ASCII string
        """
        try:
            # Take first 10 chars (5 bytes) and parse battery
            if len(payload) >= 10:
                battery_data = payload[:10]
                chunks = [battery_data[i : i + 2] for i in range(0, 10, 2)]

                # Chunks: [0]=unknown, [1]=unknown, [2]=battery_left, [3]=battery_right, [4]=unknown
                battery_left = int(chunks[2], 16) if len(chunks) > 2 else 0
                battery_right = int(chunks[3], 16) if len(chunks) > 3 else 0

                # Device name is at the end: length byte + ASCII
                data = bytes.fromhex(payload)
                name = "Unknown"

                # Look for ASCII device name at end (length-prefixed)
                for i in range(len(data) - 1, 0, -1):
                    name_len = data[i]
                    if name_len > 0 and name_len < 32 and i + name_len + 1 <= len(data):
                        try:
                            potential_name = data[i + 1 : i + 1 + name_len].decode(
                                "ascii"
                            )
                            if potential_name.isprintable():
                                name = potential_name
                                break
                        except Exception:
                            continue

                self.device_info = DeviceInfo(
                    battery_left=battery_left,
                    battery_right=battery_right,
                    name=name,
                )
                tprint(info(f"  Device: {name}"))
                tprint(info(f"  Battery: L={battery_left}% R={battery_right}%"))
        except Exception as e:
            tprint(error(f"  (couldn't parse device info: {e})"))

    async def connect(self) -> bool:
        """Connect to the Fairbuds via BLE."""
        print(f"Connecting to {self.address} via BLE...")

        self.disconnected = False

        try:
            self.client = BleakClient(
                self.address,
                timeout=10.0,
                disconnected_callback=self._disconnected_callback,
            )
            await self.client.connect()

            if not self.client.is_connected:
                print("✗ Connection failed")
                return False

            print("✓ Connected!")

            # Discover services
            print("\n" + "=" * 60)
            print("Discovering services and characteristics...")
            print("=" * 60)

            services = self.client.services
            found_ff12 = False

            for service in services:
                print(f"\nService: {service.uuid}")
                for char in service.characteristics:
                    props = []
                    if "read" in char.properties:
                        props.append("R")
                    if "write" in char.properties:
                        props.append("W")
                    if "write-without-response" in char.properties:
                        props.append("Wn")
                    if "notify" in char.properties:
                        props.append("N")
                    if "indicate" in char.properties:
                        props.append("I")
                    print(f"  └─ {char.uuid} [{','.join(props)}]")

                # Check for our target service
                if service.uuid.lower() == FAIRBUDS_SERVICE_UUID.lower():
                    found_ff12 = True

            print("\n" + "=" * 60)

            if found_ff12:
                print("✓ Found Fairbuds service (0xFF12)")
                print(f"  → Using {self.write_char} for commands")
                print(f"  → Using {self.notify_char} for responses")

                # Subscribe to notifications
                try:
                    await self.client.start_notify(
                        self.notify_char, self._notification_handler
                    )
                    print("✓ Subscribed to notifications")
                except Exception as e:
                    print(f"✗ Failed to subscribe: {e}")
            else:
                print("✗ Fairbuds service (0xFF12) not found!")
                print(
                    "  This might not be a Fairbuds device, or it uses a different protocol."
                )

            return True

        except Exception as e:
            print(f"✗ Connection failed: {e}")
            return False

    async def disconnect(self) -> None:
        """Disconnect from the device properly to allow reconnection."""
        print("Cleaning up BLE connection...")
        if self.client:
            try:
                if self.client.is_connected:
                    # Stop notifications first
                    try:
                        await self.client.stop_notify(self.notify_char)
                        print("  Stopped notifications")
                    except Exception as e:
                        print(f"  (stop notify warning: {e})")
                    # Small delay before disconnect
                    await asyncio.sleep(0.3)
                    # Disconnect
                    await self.client.disconnect()
                    print("  Disconnected")
                    # Wait for disconnect to complete
                    await asyncio.sleep(0.5)
            except Exception as e:
                print(f"  (disconnect warning: {e})")
            finally:
                self.client = None
                self.disconnected = True
        print("Disconnected")

    # =========================================================================
    # Command Building
    # =========================================================================

    def build_preset_command(self, preset: int) -> bytes:
        """Build command to set EQ preset: QXW 10 01 01 <preset>."""
        return QXW_PREFIX + bytes([CMD_SELECT_EQ, TYPE_REQUEST, 0x01, preset])

    def build_custom_eq_command(self, bands: list[tuple]) -> bytes:
        """Build command to set custom EQ: QXW 20 03 <len> <band_data...>.

        Args:
            bands: List of (band_index, gain_db, q_value) tuples

        Each band: <band_index> <gain_encoded> <q_value>
        Gain encoding: (dB * 10) + 120
        """
        num_bands = len(bands)
        length = num_bands * 3  # 3 bytes per band

        cmd = QXW_PREFIX + bytes([CMD_CUSTOM_EQ, TYPE_NOTIFY, length])

        for band_idx, gain_db, q_val in bands:
            # Encode gain (allow extended range for testing)
            gain_encoded = int(gain_db * GAIN_SCALE) + GAIN_OFFSET
            gain_encoded = max(0, min(255, gain_encoded))  # Clamp to byte range

            # Q value is a single byte
            q_val = max(0, min(255, int(q_val)))

            cmd += bytes([band_idx, gain_encoded, q_val])

        return cmd

    def build_custom_eq_simple(
        self, gains_db: list[float], q: int = DEFAULT_Q
    ) -> bytes:
        """Simplified version: just gains, using default Q for all bands."""
        bands = [(i, g, q) for i, g in enumerate(gains_db)]
        return self.build_custom_eq_command(bands)

    def build_device_info_command(self) -> bytes:
        """Build command to request device info: QXW 27 01 00."""
        return QXW_PREFIX + bytes([CMD_DEVICE_INFO, TYPE_REQUEST, 0x00])

    # =========================================================================
    # Command Sending
    # =========================================================================

    async def send_command(
        self, cmd: bytes, wait_response: bool = True, timeout: float = 5.0
    ) -> bool:
        """Send command and optionally wait for response."""
        print(dim(f"  → Sending: {cmd.hex()}"))

        # Clear previous response
        self.response_data = None
        self.response_event.clear()

        try:
            await self.client.write_gatt_char(self.write_char, cmd, response=False)

            if wait_response:
                try:
                    await asyncio.wait_for(self.response_event.wait(), timeout)
                except asyncio.TimeoutError:
                    print(dim(f"  (no response within {timeout}s)"))

            # Give DSP time to apply changes
            await asyncio.sleep(0.3)
            return True

        except Exception as e:
            print(error(f"  ✗ Error: {e}"))
            return False

    async def set_preset(self, preset: int) -> bool:
        """Set EQ preset (1-4)."""
        if preset < 1 or preset > 4:
            print(error(f"  ✗ Invalid preset {preset} (must be 1-4)"))
            return False

        cmd = self.build_preset_command(preset)
        return await self.send_command(cmd)

    async def set_custom_eq(self, bands: list[tuple]) -> bool:
        """Set custom EQ with full control: [(band, gain_db, q), ...]."""
        cmd = self.build_custom_eq_command(bands)
        return await self.send_command(cmd)

    async def set_custom_eq_simple(
        self, gains_db: list[float], q: int = DEFAULT_Q
    ) -> bool:
        """Set custom EQ band gains with uniform Q."""
        cmd = self.build_custom_eq_simple(gains_db, q)
        return await self.send_command(cmd)

    async def request_device_info(self) -> bool:
        """Request device info (battery, etc.)."""
        cmd = self.build_device_info_command()
        return await self.send_command(cmd)

    async def read_char(self, char_uuid: str) -> Optional[bytes]:
        """Read a characteristic value."""
        try:
            data = await self.client.read_gatt_char(char_uuid)
            return bytes(data)
        except Exception as e:
            print(f"  ✗ Read error: {e}")
            return None

    async def write_char(self, char_uuid: str, data: bytes) -> bool:
        """Write raw data to a characteristic."""
        try:
            await self.client.write_gatt_char(char_uuid, data, response=False)
            return True
        except Exception as e:
            print(f"  ✗ Write error: {e}")
            return False
