"""QXW Protocol constants and data types for Fairbuds BLE communication.

The Fairbuds use a proprietary "QXW" protocol, discovered by reverse
engineering the official Fairphone Fairbuds Android app.

Protocol structure:
- Header: "QXW" (0x51, 0x58, 0x57)
- Command byte
- Type byte (request/notify)
- Length byte
- Payload
"""

from dataclasses import dataclass

# =============================================================================
# BLE UUIDs (from reverse engineering EarbudsConnectionManager.java)
# =============================================================================

FAIRBUDS_SERVICE_UUID = "0000ff12-0000-1000-8000-00805f9b34fb"
FAIRBUDS_NOTIFY_UUID = "0000ff13-0000-1000-8000-00805f9b34fb"  # Notifications
FAIRBUDS_WRITE_UUID = "0000ff14-0000-1000-8000-00805f9b34fb"  # Write commands

# Alternative custom service (purpose unknown)
FAIRBUDS_CUSTOM_SERVICE_UUID = "66666666-6666-6666-6666-666666666666"
FAIRBUDS_CUSTOM_CHAR_UUID = "77777777-7777-7777-7777-777777777777"


# =============================================================================
# QXW Protocol Constants (from reverse engineering Commands.java)
# =============================================================================

# Protocol header: "QXW" (0x51, 0x58, 0x57)
QXW_PREFIX = bytes([0x51, 0x58, 0x57])

# Command codes
CMD_SELECT_EQ = 0x10  # Set preset
CMD_CUSTOM_EQ = 0x20  # Set custom EQ bands
CMD_DEVICE_INFO = 0x27  # Battery/device info request

# Command types
TYPE_REQUEST = 0x01
TYPE_NOTIFY = 0x03

# Notification codes (parsed from response)
NOTIFY_DEVICE_INFO = 0x2702  # Device info notification


# =============================================================================
# Gain Encoding
# =============================================================================

# Gain encoding: (dB * 10) + 120
# So: -10dB = 20, 0dB = 120, +10dB = 220
# Theoretical range: 0-255 → -12dB to +13.5dB
GAIN_OFFSET = 120
GAIN_SCALE = 10
GAIN_MIN_DB = -12.0  # Theoretical minimum (byte value 0)
GAIN_MAX_DB = 13.5  # Theoretical maximum (byte value 255)


def encode_gain(db: float) -> int:
    """Encode gain in dB to protocol byte value."""
    encoded = int(db * GAIN_SCALE) + GAIN_OFFSET
    return max(0, min(255, encoded))


def decode_gain(byte_val: int) -> float:
    """Decode protocol byte value to gain in dB."""
    return (byte_val - GAIN_OFFSET) / GAIN_SCALE


# =============================================================================
# Q-Factor Encoding
# =============================================================================

# Q-factor encoding: Q_real = byte_value / 10
# Examples: byte 7 → Q=0.7, byte 10 → Q=1.0, byte 30 → Q=3.0
# The app default is Q=7 (Q_real = 0.7)
# All Q values 0-255 are safe (Q=0 causes no audio output but no crash)
DEFAULT_Q = 7
Q_MIN = 0
Q_MAX = 255
Q_SCALE = 10


def encode_q(q_real: float) -> int:
    """Encode Q factor to protocol byte value."""
    encoded = int(round(q_real * Q_SCALE))
    return max(Q_MIN, min(Q_MAX, encoded))


def decode_q(byte_val: int) -> float:
    """Decode protocol byte value to Q factor."""
    return byte_val / Q_SCALE


# =============================================================================
# Band Configuration
# =============================================================================

# Default frequencies for Fairbuds (8 bands)
FAIRBUDS_FREQUENCIES = [60, 100, 230, 500, 1100, 2400, 5400, 12000]
NUM_BANDS = len(FAIRBUDS_FREQUENCIES)


# =============================================================================
# EQ Presets
# =============================================================================

# Preset name to number mapping (for CLI commands)
# Note: "studio" is preset 4 with zeroed custom EQ applied on top
PRESET_COMMANDS = {"main": 1, "bass": 2, "flat": 3, "studio": 4}

# Preset number to display name mapping
PRESET_NAMES = {1: "Main", 2: "Bass boost", 3: "Flat", 4: "Studio"}


# =============================================================================
# Data Types
# =============================================================================


@dataclass
class DeviceInfo:
    """Parsed device info from notification."""

    battery_left: int
    battery_right: int
    name: str


@dataclass
class BandConfig:
    """Configuration for a single EQ band."""

    band: int
    frequency_hz: int
    gain_db: float
    q: int = DEFAULT_Q  # Q-factor (raw byte value)
