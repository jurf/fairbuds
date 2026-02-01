"""High-level EQ control for Fairbuds.

This module provides a user-friendly interface for controlling the Fairbuds
equalizer, including preset selection, band gain control, and AutoEQ file loading.
"""

import asyncio
from typing import Optional

from .ble import FairbudsBLE
from .protocol import DEFAULT_Q, FAIRBUDS_FREQUENCIES, GAIN_MAX_DB, GAIN_MIN_DB
from .ui import dim, error, info, warning


class FairbudsEQ:
    """High-level interface for Fairbuds EQ control.

    This class provides a convenient API for:
    - Setting presets
    - Adjusting individual band gains
    - Setting Q factors
    - Loading AutoEQ parametric EQ files

    Example:
        >>> eq = FairbudsEQ("00:11:22:33:44:55")
        >>> await eq.connect()
        >>> await eq.set_preset(4)  # Studio
        >>> await eq.set_band_gain(0, 3.0)  # +3dB at 60Hz
        >>> await eq.disconnect()
    """

    def __init__(self, address: str) -> None:
        self.address = address
        self.frequencies = list(FAIRBUDS_FREQUENCIES)
        self.num_bands = len(self.frequencies)
        self.ble = FairbudsBLE(address)
        self.current_gains = [0.0] * self.num_bands  # Track current gains
        self.current_q = [DEFAULT_Q] * self.num_bands  # Track Q per band

    async def connect(self) -> bool:
        """Connect to the Fairbuds."""
        return await self.ble.connect()

    async def disconnect(self) -> None:
        """Disconnect from the Fairbuds."""
        await self.ble.disconnect()

    async def reconnect(self) -> bool:
        """Attempt to reconnect after disconnect."""
        print(dim("Attempting to reconnect..."))
        await self.ble.disconnect()  # Clean up old connection
        await asyncio.sleep(2)  # Wait for BLE stack to settle
        return await self.ble.connect()

    def is_connected(self) -> bool:
        """Check if still connected."""
        return (
            self.ble.client is not None
            and self.ble.client.is_connected
            and not self.ble.disconnected
        )

    async def set_preset(self, preset: int) -> bool:
        """Set EQ preset (1=Main, 2=Bass, 3=Flat, 4=Studio)."""
        return await self.ble.set_preset(preset)

    def _build_bands_data(self) -> list[tuple]:
        """Build bands data from current state."""
        return [
            (i, self.current_gains[i], self.current_q[i]) for i in range(self.num_bands)
        ]

    async def set_band_gain(self, band: int, gain_db: float) -> bool:
        """Set a single band gain (this sends ALL bands - QXW protocol requirement)."""
        if band < 0 or band >= self.num_bands:
            print(error(f"  ✗ Invalid band {band} (must be 0-{self.num_bands - 1})"))
            return False

        self.current_gains[band] = gain_db
        return await self.ble.set_custom_eq(self._build_bands_data())

    async def set_band_q(self, band: int, q: int) -> bool:
        """Set Q-factor for a band."""
        if band < 0 or band >= self.num_bands:
            print(error(f"  ✗ Invalid band {band}"))
            return False

        self.current_q[band] = q
        return await self.ble.set_custom_eq(self._build_bands_data())

    async def set_all_q(self, q: int) -> bool:
        """Set Q-factor for all bands."""
        self.current_q = [q] * self.num_bands
        return await self.ble.set_custom_eq(self._build_bands_data())

    async def set_all_gains(
        self, gains_db: list[float], q: Optional[int] = None
    ) -> bool:
        """Set all band gains at once."""
        if len(gains_db) != self.num_bands:
            print(error(f"  ✗ Expected {self.num_bands} gains, got {len(gains_db)}"))
            return False

        self.current_gains = list(gains_db)
        if q is not None:
            self.current_q = [q] * self.num_bands

        print(dim(f"Setting all {self.num_bands} bands..."))
        for i, g in enumerate(gains_db):
            q_str = f"Q={self.current_q[i]}" if self.current_q[i] != DEFAULT_Q else ""
            print(dim(f"  Band {i} ({self.frequencies[i]:5d}Hz): {g:+5.1f} dB {q_str}"))

        return await self.ble.set_custom_eq(self._build_bands_data())

    async def set_extended_bands(self, bands_data: list[tuple]) -> bool:
        """Set arbitrary bands with full control: [(band_idx, gain_db, q), ...]."""
        print(dim(f"Setting {len(bands_data)} bands..."))
        for band_idx, gain_db, q in bands_data:
            print(dim(f"  Band {band_idx}: {gain_db:+.1f} dB, Q={q}"))
        return await self.ble.set_custom_eq(bands_data)

    async def set_flat(self) -> bool:
        """Set flat EQ (all bands to 0 dB)."""
        print(dim("Setting all bands to 0 dB..."))
        self.current_gains = [0.0] * self.num_bands
        self.current_q = [DEFAULT_Q] * self.num_bands
        return await self.ble.set_custom_eq(self._build_bands_data())

    async def clear_custom_eq(self) -> bool:
        """Clear custom EQ by sending zeroed bands (like setEqPreset does)."""
        zeroed_bands = [(i, 0.0, DEFAULT_Q) for i in range(self.num_bands)]
        return await self.ble.set_custom_eq(zeroed_bands)

    async def request_device_info(self) -> bool:
        """Request device info (triggers notification)."""
        print(dim("Requesting device info..."))
        return await self.ble.request_device_info()

    def show_current_config(self) -> None:
        """Display current EQ configuration."""
        print(info("Current EQ Configuration:"))
        for i in range(self.num_bands):
            freq = self.frequencies[i] if i < len(self.frequencies) else 0
            gain = self.current_gains[i]
            q = self.current_q[i]
            bar_len = int(abs(gain) * 2)
            if gain >= 0:
                bar = "+" * bar_len
            else:
                bar = "-" * bar_len
            q_note = f" Q={q}" if q != DEFAULT_Q else ""
            print(f"  Band {i}: {freq:5d}Hz  {gain:+6.1f}dB  [{bar:>20}]{q_note}")

    def parse_autoeq_file(self, filename: str) -> Optional[list[tuple]]:
        """Parse AutoEQ parametric EQ file and map to 8 fixed bands.

        Args:
            filename: Path to AutoEQ .txt file (extension optional)

        Returns:
            List of (band_index, gain_db, q_byte) tuples, or None on error
        """
        # Auto-append .txt if no .txt extension
        if not filename.endswith(".txt"):
            filename = filename + ".txt"

        try:
            with open(filename, "r") as f:
                lines = f.readlines()

            # Parse filter lines
            filters = []
            for line in lines:
                line = line.strip()
                if line.startswith("Filter"):
                    # Format: Filter N: ON PK Fc XXX Hz Gain X.X dB Q X.XX
                    parts = line.split()
                    if len(parts) >= 10 and parts[2] == "ON" and parts[3] == "PK":
                        freq = float(parts[5])  # Fc value
                        gain = float(parts[8])  # Gain value
                        q = float(parts[11])  # Q value
                        filters.append((freq, gain, q))

            if len(filters) != 8:
                print(warning(f"  Warning: Expected 8 filters, found {len(filters)}"))
                return None

            # Map to 8 fixed frequency bands
            band_data = []
            for i, (freq, gain, q) in enumerate(filters):
                # Clamp gain to valid range
                if gain < GAIN_MIN_DB:
                    print(warning(f"  Band {i}: clamping {gain:.1f} to {GAIN_MIN_DB}"))
                    gain = GAIN_MIN_DB
                elif gain > GAIN_MAX_DB:
                    print(warning(f"  Band {i}: clamping {gain:.1f} to {GAIN_MAX_DB}"))
                    gain = GAIN_MAX_DB

                # Convert Q to byte (Q_byte = Q_real * 10)
                q_byte = int(round(q * 10))
                q_byte = max(0, min(255, q_byte))

                band_data.append((i, gain, q_byte))
                print(
                    dim(
                        f"  Band {i} ({self.frequencies[i]:5d}Hz): {gain:+5.1f} dB, Q={q:.2f}"
                    )
                )

            return band_data

        except FileNotFoundError:
            print(error(f"  Error: File '{filename}' not found"))
            return None
        except Exception as e:
            print(error(f"  Error parsing file: {e}"))
            return None
