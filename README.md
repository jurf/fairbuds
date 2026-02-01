# Fairbuds EQ Tool

Direct BLE protocol interface for Fairphone Fairbuds equalizer control.

## Features

- Set EQ presets (Main, Bass, Flat, Studio)
- More EQ control
  - -12 to +13.5 dB per band (vs. app limited ±10 dB)
  - Customisable Q-factor (vs. app hardcoded 0.7)
- Load AutoEQ parametric EQ files (bundled AutoEQ database)
- Battery level monitoring
- Interactive CLI with command history

## Quick Start

### Clone the repository

```bash
git clone --recurse-submodules https://github.com/user/fairbuds.git
cd fairbuds
```

If you already cloned without `--recurse-submodules`:
```bash
git submodule update --init --recursive
```

### Install with uv (recommended)

[uv](https://docs.astral.sh/uv/) is a fast Python package manager. Install it first:
```bash
# Linux/macOS
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or with pipx
pipx install uv
```

Then install dependencies:
```bash
uv sync
```

## Finding Your Fairbuds BLE Address

The BLE address is **different** from the audio (BR/EDR) address shown in Bluetooth settings!

```bash
# Start LE scan
bluetoothctl scan le

# Look for your Fairbuds in the list (usually named "Fairbuds")
# The address looks like: 00:11:22:33:44:55
```

## Usage

```bash
# With uv
uv run fairbuds <ble_address>

# Or if installed with pip
fairbuds <ble_address>

# Example
uv run fairbuds 00:11:22:33:44:55
```

### Command-line options

```bash
fairbuds --help              # Show help
fairbuds --version           # Show version
fairbuds --list-presets      # List available AutoEQ presets
fairbuds <address>           # Connect to device
```

**Note:** The BLE address is different from the audio (BR/EDR) address!
Use `bluetoothctl scan le` to find the BLE address of your Fairbuds.

## Generating AutoEQ presets

```bash
cd AutoEq
python -m autoeq --input-file="measurements/rtings/data/in-ear/Bruel & Kjaer 5128/Fairphone Fairbuds.csv" --output-dir="../results" --target="targets/JM-1 with Harman filters.csv" --max-gain=12 --parametric-eq --parametric-eq-config=../pex/fairbuds.yaml --fs=48000 --preamp=-1
```

Manually adjust the max gain depending on how much volume you are willing to lose, and manually tune the preamp to avoid audio quality loss without leading to overflows during calculation.
