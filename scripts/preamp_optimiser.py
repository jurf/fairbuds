"""
AutoEq behaves quite differently based on different preamp values. This is a
simple script that brute-forces the best preamp for all generated EQs
"""

import multiprocessing
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
AUTOEQ_DIR = Path(ROOT, "AutoEq")
MEASUREMENTS_DIR = Path(ROOT, "measurements")
SIGNATURES_DIR = Path(ROOT, "signatures")
PEX_DIR = Path(ROOT, "pex")

MIN_PREAMP = -8
MAX_PREAMP = 4
STEP = 0.1

CONFIGS = {
    "presets/rtings": {
        "measurement": "RTINGS (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        "bass_boost": 6.5,
    },
    "presets/dhrme": {
        "measurement": "DHRME (studio eq, ANC Off)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8,
    },
    "presets/dhrme_anc": {
        "measurement": "DHRME (studio eq, ANC On)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8,
    },
    "presets_app/rtings": {
        "measurement": "RTINGS (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        "bass_boost": 6.5,
        "is_app": True,
    },
    "presets_app/dhrme": {
        "measurement": "DHRME (studio eq, ANC Off)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8,
        "is_app": True,
    },
    "presets_app/dhrme_anc": {
        "measurement": "DHRME (studio eq, ANC On)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8,
        "is_app": True,
    },
}


def calculate_parametric(df, preamp):
    df["parametric_equalized_raw"] = df["raw"] + df["parametric_eq"] - preamp
    df["parametric_equalized_smoothed"] = df["smoothed"] + df["parametric_eq"] - preamp

    df["parametric_error"] = df["error"] + df["parametric_eq"] - preamp
    df["parametric_error_smoothed"] = (
        df["error_smoothed"] + df["parametric_eq"] - preamp
    )

    return df


def run(
    results,
    preamp=0,
    signature=None,
    target="JM-1 with Harman treble filter.csv",
    measurement="RTINGS (main eq, ANC Off)",
    bass_boost=6.5,
    is_app=False,
):
    results_dir = Path(ROOT, "results_app" if is_app else "results")
    pex_config = Path(PEX_DIR, f"fairbuds{'_app' if is_app else ''}.yaml")
    input_file = Path(MEASUREMENTS_DIR, f"{measurement}.csv")
    target_path = Path(AUTOEQ_DIR, "targets", target)

    cmd = [
        str(Path(AUTOEQ_DIR, ".venv", "bin", "python")),
        "-m",
        "autoeq",
        f"--input-file={input_file}",
        f"--output-dir={results_dir}",
        f"--target={target_path}",
        # Tops out at around 16kHz
        "--max-gain=12",
        "--parametric-eq",
        f"--parametric-eq-config={pex_config}",
        # The sound signature is already reconstructed, no need for smoothing
        "--sound-signature-smoothing-window-size=0",
        # Based on Android's report in Developer Options
        "--fs=44100",
        f"--bass-boost={bass_boost}",
        # This is my personal preference, but it's not like we can save the
        # treble anyway
        "--treble-boost=-3",
        f"--preamp={preamp:.2f}",
    ]
    if signature:
        cmd.append(f"--sound-signature={Path(SIGNATURES_DIR, signature)}")
    subprocess.run(
        cmd,
        check=True,
        cwd=AUTOEQ_DIR,
        env={"VIRTUAL_ENV": str(Path(AUTOEQ_DIR, ".venv"))},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    df = pd.read_csv(Path(results_dir, measurement, f"{measurement}.csv"))
    df = calculate_parametric(df, preamp)

    # The Fairbuds are not really capable of producing sound above 16kHz
    std = df[(df["frequency"] <= 16000)]["parametric_error_smoothed"].std()
    results.append((std, preamp, df))
    return results


def optimise_preamp(name, config, position=0):
    results = []
    current_preamp = MIN_PREAMP

    best_std = float("inf")
    best_preamp = None

    pbar = tqdm(
        total=int((MAX_PREAMP - current_preamp) / STEP) + 1,
        desc=name,
        unit="step",
        position=position,
        leave=True,
    )
    while current_preamp <= MAX_PREAMP:
        results = run(results, current_preamp, **config)
        std = results[-1][0]
        if std < best_std:
            best_std = std
            best_preamp = current_preamp
        pbar.set_postfix(preamp=f"{best_preamp:.1f} dB", std=f"{best_std:.2f} dB")
        pbar.update(1)
        current_preamp = round(current_preamp + STEP, 2)
    pbar.close()

    # Final run with optimal preamp
    results = run(results, best_preamp, **config)
    # Copy EQ to final location
    is_app = config.get("is_app", False)
    results_dir = Path(ROOT, "results_app" if is_app else "results")
    src = Path(
        results_dir, config["measurement"], f"{config['measurement']} ParametricEQ.txt"
    )
    dst = Path(ROOT, name + ".txt")
    shutil.copy(src, dst)
    return name, best_preamp, best_std


if __name__ == "__main__":
    workers = max(1, multiprocessing.cpu_count() - 1)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(optimise_preamp, name, config, i): name
            for i, (name, config) in enumerate(CONFIGS.items())
        }
        results = {}
        for future in as_completed(futures):
            name, preamp, std = future.result()
            results[name] = (preamp, std)

    # Print blank lines to clear past the tqdm bars
    print("\n" * len(CONFIGS))
    print("=== Results ===")
    for name in CONFIGS.keys():
        preamp, std = results[name]
        print(f"  {name}: preamp={preamp:.2f} dB, std={std:.4f}")
