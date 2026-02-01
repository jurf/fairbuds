"""Terminal UI helpers for Fairbuds CLI.

Provides:
- ANSI color codes and formatting helpers
- TerminalUI class for printing above readline prompt
"""

import sys

try:
    import readline
except ImportError:
    readline = None  # type: ignore


# =============================================================================
# ANSI Color Codes
# =============================================================================


class Color:
    """ANSI color codes for terminal output."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    # Foreground colors
    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"

    # Bright foreground colors
    BRIGHT_BLACK = "\033[90m"
    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"
    BRIGHT_WHITE = "\033[97m"


# =============================================================================
# Formatting Helpers
# =============================================================================


def success(msg: str) -> str:
    """Format message as success (green)."""
    return f"{Color.GREEN}{msg}{Color.RESET}"


def error(msg: str) -> str:
    """Format message as error (red)."""
    return f"{Color.RED}{msg}{Color.RESET}"


def warning(msg: str) -> str:
    """Format message as warning (yellow)."""
    return f"{Color.YELLOW}{msg}{Color.RESET}"


def info(msg: str) -> str:
    """Format message as info (cyan)."""
    return f"{Color.CYAN}{msg}{Color.RESET}"


def dim(msg: str) -> str:
    """Format message as dim (gray)."""
    return f"{Color.DIM}{msg}{Color.RESET}"


def bold(msg: str) -> str:
    """Format message as bold."""
    return f"{Color.BOLD}{msg}{Color.RESET}"


# =============================================================================
# Terminal UI Helper
# =============================================================================


class TerminalUI:
    """Handles printing messages above the readline prompt without corruption.

    This is a singleton class - use TerminalUI.get() to get the instance.

    When readline is waiting for input and we receive an async BLE notification,
    we need to print the message above the prompt and then redraw the prompt
    with whatever the user has typed so far.
    """

    PROMPT = f"{Color.BRIGHT_CYAN}fairbuds>{Color.RESET} "
    PROMPT_PLAIN = "fairbuds> "  # For length calculation (no ANSI)

    _instance: "TerminalUI | None" = None

    def __init__(self) -> None:
        self.active = False  # True when readline is waiting for input

    @classmethod
    def get(cls) -> "TerminalUI":
        """Get the singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def print_above(self, msg: str) -> None:
        """Print a message above the current prompt, then redisplay prompt."""
        if not self.active or not readline:
            # Not in readline mode, just print normally
            print(msg)
            return

        # Save what user has typed so far
        current_input = readline.get_line_buffer()

        # Move to beginning of line, clear it
        sys.stdout.write("\r\033[K")

        # Print the message
        sys.stdout.write(msg + "\n")

        # Redraw prompt and current input
        sys.stdout.write(self.PROMPT + current_input)
        sys.stdout.flush()

        # Tell readline to refresh its display
        readline.redisplay()


def tprint(msg: str) -> None:
    """Print message above readline prompt.

    Use this for async BLE notifications that arrive while the user
    is typing at the prompt. For regular command output, use print().
    """
    TerminalUI.get().print_above(msg)
