"""Fairbuds EQ Tool - BLE control for Fairphone Fairbuds equalizer."""

__version__ = "0.1.0"

from .eq import FairbudsEQ
from .protocol import (
    DEFAULT_Q,
    FAIRBUDS_FREQUENCIES,
    GAIN_MAX_DB,
    GAIN_MIN_DB,
    PRESET_COMMANDS,
    PRESET_NAMES,
)

__all__ = [
    "FairbudsEQ",
    "FAIRBUDS_FREQUENCIES",
    "PRESET_COMMANDS",
    "PRESET_NAMES",
    "DEFAULT_Q",
    "GAIN_MIN_DB",
    "GAIN_MAX_DB",
]
