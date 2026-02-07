"""Interactive CLI for Fairbuds EQ control."""

import argparse
import asyncio
import os
import signal
import sys
from pathlib import Path

from bleak import BleakScanner
from bleak.exc import BleakError

from . import __version__
from .eq import FairbudsEQ
from .protocol import GAIN_MAX_DB, GAIN_MIN_DB, PRESET_COMMANDS, PRESET_NAMES
from .ui import TerminalUI, dim, error, info, success, warning

try:
    import readline
except ImportError:
    readline = None  # type: ignore


def get_presets_dir() -> Path:
    """Get the presets directory path."""
    # First check relative to the package
    package_dir = Path(__file__).parent.parent.parent
    presets_dir = package_dir / "presets"
    if presets_dir.exists():
        return presets_dir
    # Fall back to current directory
    return Path.cwd()


def list_presets() -> list[str]:
    """List available preset files."""
    presets_dir = get_presets_dir()
    if not presets_dir.exists():
        return []
    return sorted([f.stem for f in presets_dir.glob("*.txt")])


def resolve_preset_path(name: str) -> str:
    """Resolve a preset name to a full path.

    Checks in order:
    1. If it's an absolute path or exists as-is, use it
    2. Look in the presets directory
    3. Return original name (will fail later with helpful error)
    """
    # Add .txt if needed
    if not name.endswith(".txt"):
        name_with_ext = name + ".txt"
    else:
        name_with_ext = name

    # Check if it exists as-is
    if os.path.exists(name_with_ext):
        return name_with_ext
    if os.path.exists(name):
        return name

    # Check in presets directory
    presets_dir = get_presets_dir()
    preset_path = presets_dir / name_with_ext
    if preset_path.exists():
        return str(preset_path)

    # Return original (will fail with helpful error)
    return name_with_ext


def print_help() -> None:
    """Print help message."""
    presets = list_presets()
    presets_info = f"  Available: {', '.join(presets)}" if presets else "  (none found)"
    print(f"""
Fairbuds EQ Tool - Commands:
═══════════════════════════════════════════════════════════════════════════════

  PRESETS (built-in DSP modes):
    main                 - Main preset (default sound signature)
    bass                 - Bass boost preset
    flat                 - Flat preset (neutral DSP)
    studio               - Studio preset (custom EQ zeroed)

  CUSTOM EQ (8 bands: 60, 100, 230, 500, 1100, 2400, 5400, 12000 Hz):
    eq <g0> <g1>...      - Set all 8 band gains at once
    gain <band> <dB>     - Set single band gain (-12 to +13.5 dB)
    load/l <file>        - Load AutoEQ parametric EQ file (.txt optional)
    presets              - List available preset files
{presets_info}

  Q-FACTOR CONTROL:
    q <band> <value>     - Set Q for single band (Q_real = value/10)
    qall <value>         - Set Q for ALL bands

  INFO:
    show                 - Show current EQ settings
    bands                - Show band frequencies
    info                 - Request device info (battery)

  CONNECTION:
    scan                 - Scan for BLE devices (helps wake up BLE stack)
    reconnect            - Reconnect after BLE disconnect

  DEBUG:
    services             - List all BLE services
    read <uuid>          - Read a characteristic
    write <uuid> <hex>   - Write raw hex to characteristic
    raw <hex>            - Send raw QXW command

  help / quit

Gain: byte = (dB × 10) + 120  →  0=-12dB, 120=0dB, 255=+13.5dB
Q-factor: Q_real = byte / 10  (byte 7 → Q=0.7, byte 30 → Q=3.0)
═══════════════════════════════════════════════════════════════════════════════
""")


async def interactive_mode(eq: FairbudsEQ) -> None:
    """Run interactive command loop."""
    # Setup readline for command history
    history_file = os.path.expanduser("~/.fairbuds_eq_history")

    if readline:
        readline.parse_and_bind("tab: complete")
        readline.set_history_length(1000)

        # Load history from file
        if os.path.exists(history_file):
            try:
                readline.read_history_file(history_file)
                print(
                    dim(
                        f"Loaded {readline.get_current_history_length()} commands from history"
                    )
                )
            except Exception as e:
                print(dim(f"Could not load history: {e}"))

    print_help()

    # Install signal handler for Ctrl-C
    loop = asyncio.get_event_loop()
    should_exit = False

    def signal_handler(signum, frame):
        nonlocal should_exit
        should_exit = True
        print("\n\nExiting...")

    signal.signal(signal.SIGINT, signal_handler)

    # Get terminal UI instance
    tui = TerminalUI.get()

    while not should_exit:
        try:
            # Mark that readline is active (for tprint to work correctly)
            tui.active = True

            # Use readline for persistent prompt
            cmd_str = await loop.run_in_executor(None, lambda: input(TerminalUI.PROMPT))

            # Mark readline as inactive while processing command
            tui.active = False

            cmd = cmd_str.strip().split()

            if not cmd:
                continue

            cmd_name = cmd[0].lower()

            if cmd_name in ("quit", "exit", "q"):
                break

            elif cmd_name == "reconnect":
                if await eq.reconnect():
                    print(success("✓ Reconnected!"))
                else:
                    print(error("✗ Reconnect failed. Try:"))
                    print("   1. Put earbuds in case, close lid")
                    print("   2. Wait 5 seconds")
                    print("   3. Take out earbuds")
                    print("   4. Try 'scan' then 'reconnect' again")
                continue

            elif cmd_name == "scan":
                print(dim("Scanning for BLE devices (5 seconds)..."))
                try:
                    devices = await BleakScanner.discover(timeout=5.0)
                    print(info(f"Found {len(devices)} BLE devices:"))
                    for d in sorted(devices, key=lambda x: getattr(x, 'rssi', -100), reverse=True):
                        rssi = f"{d.rssi:4d} dBm" if getattr(d, 'rssi', None) else "  ?? dBm"
                        name = d.name or "(unknown)"
                        marker = " ←" if d.address.upper() == eq.address.upper() else ""
                        print(f"  {d.address}  {rssi}  {name}{marker}")
                    print(dim("\nScan complete. Try 'reconnect' now."))
                except Exception as e:
                    print(error(f"Scan failed: {e}"))
                continue

            # Check connection before other commands
            if not eq.is_connected():
                print(
                    warning("⚠️  Not connected. Type 'reconnect' to try reconnecting.")
                )
                continue

            if cmd_name == "help":
                print_help()

            # Direct preset commands: main, bass, flat, studio
            elif cmd_name in PRESET_COMMANDS:
                preset_name = cmd_name
                preset_num = PRESET_COMMANDS[preset_name]
                # Implement setEqPreset logic from Java:
                # - For studio: switch to preset 4 first, then apply zeroed custom EQ
                # - For others: clear custom EQ first (send zeroed), then switch preset
                if preset_name == "studio":
                    print(dim("Switching to Studio EQ..."))
                    if await eq.set_preset(preset_num):
                        await asyncio.sleep(0.1)
                        # Apply zeroed custom EQ
                        if await eq.set_flat():
                            print(success(f"✓ {PRESET_NAMES[preset_num]} EQ applied"))
                        else:
                            print(error("✗ Failed to apply zeroed EQ"))
                    else:
                        print(error("✗ Failed to set preset"))
                else:
                    # For main/bass/flat: clear custom EQ first, then switch preset
                    print(dim("Clearing custom EQ..."))
                    if await eq.clear_custom_eq():
                        await asyncio.sleep(0.1)
                        print(dim(f"Switching to {preset_name} preset..."))
                        if await eq.set_preset(preset_num):
                            print(
                                success(f"✓ {PRESET_NAMES[preset_num]} preset applied")
                            )
                        else:
                            print(error("✗ Failed to set preset"))
                    else:
                        print(error("✗ Failed to clear custom EQ"))

            elif cmd_name == "gain" and len(cmd) >= 3:
                band = int(cmd[1])
                gain = float(cmd[2])
                # Now supports extended range -12 to +13.5 dB
                if gain < GAIN_MIN_DB or gain > GAIN_MAX_DB:
                    print(
                        info(
                            f"  Info: Using extended gain {gain:+.1f} dB (range: {GAIN_MIN_DB} to {GAIN_MAX_DB})"
                        )
                    )
                eq.current_gains[band] = gain
                if await eq.ble.set_custom_eq(eq._build_bands_data()):
                    print(success(f"✓ Band {band} set to {gain:+.1f} dB"))
                else:
                    print(error("✗ Failed"))

            elif cmd_name == "eq" and len(cmd) >= 9:
                gains = [float(x) for x in cmd[1:9]]
                if await eq.set_all_gains(gains):
                    print(success("✓ Custom EQ applied"))
                else:
                    print(error("✗ Failed"))

            elif cmd_name == "info":
                await eq.request_device_info()

            elif cmd_name == "show":
                eq.show_current_config()

            elif cmd_name == "bands":
                print(info("Band frequencies:"))
                for i, freq in enumerate(eq.frequencies):
                    print(f"  Band {i}: {freq:5d} Hz")

            elif cmd_name == "services":
                print(info("Services and characteristics:"))
                for service in eq.ble.client.services:
                    print(f"\nService: {service.uuid}")
                    for char in service.characteristics:
                        props = char.properties
                        print(f"  └─ {char.uuid} [{', '.join(props)}]")

            elif cmd_name == "read" and len(cmd) >= 2:
                char_uuid = cmd[1]
                print(dim(f"Reading {char_uuid}..."))
                data = await eq.ble.read_char(char_uuid)
                if data:
                    print(f"  Hex: {data.hex()}")
                    try:
                        print(f"  ASCII: {data.decode('ascii', errors='replace')}")
                    except Exception:
                        pass

            elif cmd_name == "write" and len(cmd) >= 3:
                char_uuid = cmd[1]
                hex_data = "".join(cmd[2:])
                data = bytes.fromhex(hex_data)
                print(dim(f"Writing to {char_uuid}: {data.hex()}"))

                # Clear response event
                eq.ble.response_data = None
                eq.ble.response_event.clear()

                if await eq.ble.write_char(char_uuid, data):
                    print(success("✓ Write successful"))
                    try:
                        await asyncio.wait_for(eq.ble.response_event.wait(), 2.0)
                        if eq.ble.response_data:
                            print(dim(f"  ← Response: {eq.ble.response_data.hex()}"))
                    except asyncio.TimeoutError:
                        print(dim("  (no response)"))

            elif cmd_name == "raw" and len(cmd) >= 2:
                # Send raw command (with QXW prefix if not present)
                hex_data = "".join(cmd[1:])
                if not hex_data.startswith("515857"):
                    hex_data = "515857" + hex_data
                data = bytes.fromhex(hex_data)
                print(dim("Sending raw command..."))
                await eq.ble.send_command(data)

            elif cmd_name == "q" and len(cmd) >= 3:
                band = int(cmd[1])
                q_val = int(cmd[2])
                if await eq.set_band_q(band, q_val):
                    print(success(f"✓ Band {band} Q set to {q_val}"))
                else:
                    print(error("✗ Failed"))

            elif cmd_name == "qall" and len(cmd) >= 2:
                q_val = int(cmd[1])
                if await eq.set_all_q(q_val):
                    print(success(f"✓ All bands Q set to {q_val}"))
                else:
                    print(error("✗ Failed"))

            elif cmd_name in ("load", "l") and len(cmd) >= 2:
                filename = resolve_preset_path(cmd[1])
                print(dim(f"Loading AutoEQ file: {filename}"))
                band_data = eq.parse_autoeq_file(filename)
                if band_data:
                    eq.current_gains = [g for _, g, _ in band_data]
                    eq.current_q = [q for _, _, q in band_data]
                    if await eq.ble.set_custom_eq(band_data):
                        print(success("✓ AutoEQ curve applied"))
                    else:
                        print(error("✗ Failed to apply EQ"))
                else:
                    print(error("✗ Failed to parse file"))

            elif cmd_name == "presets":
                presets = list_presets()
                if presets:
                    print(info(f"Available presets in {get_presets_dir()}:"))
                    for p in presets:
                        print(f"  {p}")
                else:
                    print(warning("No presets found"))

            else:
                print(
                    warning(
                        f"Unknown command: {cmd_name}. Type 'help' for available commands."
                    )
                )

        except KeyboardInterrupt:
            # Ctrl-C pressed - exit gracefully
            tui.active = False
            should_exit = True
            print("\n\nExiting...")
            break
        except ValueError as e:
            tui.active = False
            print(f"Invalid value: {e}")
        except BleakError as e:
            tui.active = False
            print(f"\n⚠️  BLE Error: {e}")
            print("   Connection may be lost. Try 'reconnect'.")
            eq.ble.disconnected = True
        except EOFError:
            # Handle case where input stream closes
            tui.active = False
            break
        except Exception as e:
            tui.active = False
            error_str = str(e).lower()
            if "disconnect" in error_str or "not connected" in error_str:
                print(f"\n⚠️  BLE Disconnected: {e}")
                print("   Try 'reconnect' after putting earbuds in case briefly.")
                eq.ble.disconnected = True
            else:
                print(f"Error: {e}")
                import traceback

                traceback.print_exc()

    # Ensure TUI is inactive
    tui.active = False

    # Save history on exit
    if readline and history_file:
        try:
            readline.write_history_file(history_file)
        except Exception:
            pass  # Silently ignore history save errors


async def main_async(address: str) -> None:
    """Async main entry point."""
    eq = FairbudsEQ(address)

    if not await eq.connect():
        return

    try:
        await interactive_mode(eq)
    finally:
        await eq.disconnect()


def create_parser() -> argparse.ArgumentParser:
    """Create argument parser."""
    parser = argparse.ArgumentParser(
        prog="fairbuds",
        description="BLE control tool for Fairphone Fairbuds equalizer",
        epilog="""
Examples:
  fairbuds 00:11:22:33:44:55          Connect to Fairbuds
  fairbuds --scan                     Scan for BLE devices
  fairbuds --presets                  List available EQ presets

Note: The BLE address is different from the audio (BR/EDR) address.
Use 'bluetoothctl scan le' to find the BLE address of your Fairbuds.
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "address",
        nargs="?",
        help="BLE address of the Fairbuds (e.g., 00:11:22:33:44:55)",
    )

    parser.add_argument(
        "--version",
        "-V",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    parser.add_argument(
        "--scan",
        "-s",
        action="store_true",
        help="Scan for BLE devices and exit",
    )

    parser.add_argument(
        "--presets",
        "-p",
        action="store_true",
        help="List available EQ presets and exit",
    )

    return parser


async def scan_devices() -> None:
    """Scan for BLE devices."""
    print(dim("Scanning for BLE devices (5 seconds)..."))
    try:
        devices = await BleakScanner.discover(timeout=5.0)
        print(info(f"Found {len(devices)} BLE devices:"))
        for d in sorted(devices, key=lambda x: getattr(x, 'rssi', -100), reverse=True):
            rssi = f"{d.rssi:4d} dBm" if getattr(d, 'rssi', None) else "  ?? dBm"
            name = d.name or "(unknown)"
            print(f"  {d.address}  {rssi}  {name}")
    except Exception as e:
        print(error(f"Scan failed: {e}"))
        sys.exit(1)


def main() -> None:
    """Main entry point."""
    parser = create_parser()
    args = parser.parse_args()

    # Handle --scan
    if args.scan:
        asyncio.run(scan_devices())
        return

    # Handle --presets
    if args.presets:
        presets = list_presets()
        presets_dir = get_presets_dir()
        if presets:
            print(info(f"Available presets in {presets_dir}:"))
            for p in presets:
                print(f"  {p}")
        else:
            print(warning(f"No presets found in {presets_dir}"))
        return

    # Require address for normal operation
    if not args.address:
        parser.print_help()
        sys.exit(1)

    asyncio.run(main_async(args.address))


if __name__ == "__main__":
    main()
