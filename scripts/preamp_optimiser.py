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

# Add to AutoEq/autoeq/peq.py, at the end of PEQ::optimise()
# ```python
#         print(f'LOSS={np.min(self.history.loss)}', flush=True)`
# ```
PATCHED_AUTOEQ = True

ROOT = Path(__file__).resolve().parent.parent
AUTOEQ_DIR = Path(ROOT, "AutoEq")
MEASUREMENTS_DIR = Path(ROOT, "measurements")
SIGNATURES_DIR = Path(ROOT, "signatures")
PEX_DIR = Path(ROOT, "pex")

MIN_PREAMP = -6
MAX_PREAMP = 3
STEP = 0.1

# Personal preference. Perhaps my seal is worse than average as all measurements
# show a pretty accurate bass response, but I hear a reduced bass response
# compared to my equalised Sennheiser HD 560s.
# Might need less with smaller tips or with foam tips?
BASS_BOOST = 1.5

CONFIGS = {
    "presets/rtings": {
        "measurement": "RTINGS (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        # "target": "JM-1 with Harman filters.csv",
        "bass_boost": f"{6.5 + BASS_BOOST}",  # ,105,0.8",
        # "bass_boost": 0,
    },
    "presets/soundguys": {
        "measurement": "SoundGuys (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        # "target": "JM-1 with Harman filters.csv",
        "bass_boost": f"{6.5 + BASS_BOOST}",  # ,105,0.8",
        # "bass_boost": 0,
    },
    "presets/dhrme": {
        "measurement": "DHRME (studio eq, ANC Off)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8 + BASS_BOOST,
    },
    "presets/dhrme_anc": {
        "measurement": "DHRME (studio eq, ANC On)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8 + BASS_BOOST,
    },
    "presets_app/rtings": {
        "measurement": "RTINGS (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        # "target": "JM-1 with Harman filters.csv",
        "bass_boost": f"{6.5 + BASS_BOOST}",
        # "bass_boost": 0,
        "is_app": True,
    },
    "presets_app/soundguys": {
        "measurement": "SoundGuys (main eq, ANC Off)",
        "signature": "reconstructed.csv",
        "target": "JM-1 with Harman treble filter.csv",
        # "target": "JM-1 with Harman filters.csv",
        "bass_boost": f"{6.5 + BASS_BOOST}",  # ,105,0.8",
        # "bass_boost": 0,
        "is_app": True,
    },
    "presets_app/dhrme": {
        "measurement": "DHRME (studio eq, ANC Off)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8 + BASS_BOOST,
        "is_app": True,
    },
    "presets_app/dhrme_anc": {
        "measurement": "DHRME (studio eq, ANC On)",
        "target": "AutoEq in-ear.csv",
        "bass_boost": 8 + BASS_BOOST,
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


def parse_loss(lines):
    for line in lines:
        if line.startswith("LOSS="):
            return float(line.split("=")[1])
    raise ValueError("LOSS not found in output:\n" + "\n".join(lines))


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
        "--max-gain=16",
        "--parametric-eq",
        f"--parametric-eq-config={pex_config}",
        # The sound signature is already reconstructed, no need for smoothing
        "--sound-signature-smoothing-window-size=0",
        # Based on Android's report in Developer Options
        "--fs=44100",
        f"--bass-boost={bass_boost}",
        # This is my personal preference, but it's not like we can save the
        # treble anyway
        "--treble-boost=-2",
        f"--preamp={preamp:.2f}",
        "--thread-count=1",
        # "--standardize-input",
    ]
    if signature:
        cmd.append(f"--sound-signature={Path(SIGNATURES_DIR, signature)}")
    proc = subprocess.Popen(
        cmd,
        cwd=AUTOEQ_DIR,
        env={"VIRTUAL_ENV": str(Path(AUTOEQ_DIR, ".venv"))},
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    output = proc.communicate()[0].decode("utf-8")

    if PATCHED_AUTOEQ:
        loss = parse_loss(output.splitlines())
    else:
        df = pd.read_csv(Path(results_dir, measurement, f"{measurement}.csv"))
        df = calculate_parametric(df, preamp)

        # The Fairbuds are not really capable of producing sound above 16kHz
        loss = df[(df["frequency"] <= 16000)]["parametric_error_smoothed"].std()
    results.append((loss, preamp))
    return results


def extract_error(results_dir, measurement, preamp):
    df = pd.read_csv(Path(results_dir, measurement, f"{measurement}.csv"))
    df["parametric_error_smoothed"] = (
        df["error_smoothed"] + df["parametric_eq"] - preamp
    )
    df = df[["frequency", "parametric_error_smoothed"]].rename(
        columns={"parametric_error_smoothed": "raw"}
    )
    df = df.round(2)
    df.to_csv(
        Path(results_dir, measurement, f"{measurement} fine-tuning.csv"), index=False
    )
    # The Fairbuds are not really capable of producing sound above 16kHz
    return df


def optimise_preamp(name, config, position=0):
    results = []
    current_preamp = MIN_PREAMP

    best_std = float("inf")
    best_preamp = None

    # Final location settings
    is_app = config.get("is_app", False)
    results_dir = Path(ROOT, "results_app" if is_app else "results")
    src = Path(
        results_dir, config["measurement"], f"{config['measurement']} ParametricEQ.txt"
    )
    dst = Path(ROOT, name + ".txt")

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
            # Allow testing while we wait
            shutil.copy(src, dst)
        pbar.set_postfix(preamp=f"{best_preamp:.1f} dB", loss=f"{best_std:.2f}")
        pbar.update(1)
        current_preamp = round(current_preamp + STEP, 2)
    pbar.close()

    # Final run with optimal preamp
    results = run(results, best_preamp, **config)

    # Extract the error for Wavelet fine-tuning
    extract_error(results_dir, config["measurement"], best_preamp)

    return name, best_preamp, best_std


if __name__ == "__main__":
    workers = max(1, multiprocessing.cpu_count() - 3)
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
        preamp, loss = results[name]
        print(f"  {name}: preamp={preamp:.1f} dB, loss={loss:.2f}")
