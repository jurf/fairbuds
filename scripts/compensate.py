"""
RTINGS only did measurements on the Main preset, but only the Studio preset has
a configurable EQ. This script applies naive compensation to an EQ built on the
Main preset for better performance on the Studio preset.
"""

import sys

if len(sys.argv) != 2:
    print("Usage: python compensate.py <preset_name>")
    sys.exit(1)

filename = sys.argv[1]

# From presets/main-ish.txt
compensations = [-1, 1, 2, 3.5, 1, -3, 1, 1]


with open(f"../presets/{filename}") as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    # E.g.:
    # Filter 1: ON PK Fc 60 Hz Gain -2.8 dB Q 0.17

    # Compensate gains
    if line.startswith("Filter"):
        parts = line.split()
        index = int(parts[1][:-1])
        new_gain = float(parts[8]) + compensations[index - 1]
        new_gain = max(-12, min(13.5, new_gain))
        parts[8] = f"{new_gain:.1f}"
        line = " ".join(parts) + "\n"
    new_lines.append(line)

with open(f"../presets/{filename}", "w") as f:
    f.writelines(new_lines)
