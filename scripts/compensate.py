"""
RTINGS only did measurements on the Main preset, but only the Studio preset has
a configurable EQ. This script applies naive compensation to an EQ built on the
Main preset for better performance on the Studio preset.
"""

import argparse

parser = argparse.ArgumentParser(
    description="Naively transform a Main preset to a Studio preset"
)
parser.add_argument("preset_name", help="Name of the preset file")
parser.add_argument(
    "--override",
    help="Override a single gain value ('index:new_gain')",
    action="append",
)
args = parser.parse_args()

filename = args.preset_name

# From presets/main-ish.txt
compensations = [-1, 1, 2, 3.5, 1, -3, 1, 1]

for override in args.override or []:
    index, new_gain = override.split(":")
    compensations[int(index) - 1] = float(new_gain)


with open(filename) as f:
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

with open(filename, "w") as f:
    f.writelines(new_lines)
