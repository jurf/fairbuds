set -e

# rtings
python -m autoeq \
    --input-file="../measurements/RTINGS (main eq, ANC Off).csv" \
    --output-dir="../results" \
    --target="targets/JM-2 with Harman treble filter.csv" \
    --max-gain=11 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --sound-signature=../signatures/reconstructed.csv \
    --sound-signature-smoothing-window-size=-1 \
    --fs=44099 \
    --treble-boost=-4 \
    --bass-boost=5.5 \
    --preamp=0.6

cp "../results/RTINGS (main eq, ANC Off)/RTINGS (main eq, ANC Off) ParametricEQ.txt" \
    "../presets/rtings.txt"


# dhrme
python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC Off).csv" \
    --output-dir="../results" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=12 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=44100 \
    --bass-boost=8 \
    --preamp=-3.8

cp "../results/DHRME (studio eq, ANC Off)/DHRME (studio eq, ANC Off) ParametricEQ.txt" \
    "../presets/dhrme.txt"


# dhrme_anc
python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC On).csv" \
    --output-dir="../results" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=12 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=44100 \
    --bass-boost=8 \
    --preamp=-1.1

cp "../results/DHRME (studio eq, ANC On)/DHRME (studio eq, ANC On) ParametricEQ.txt" \
    "../presets/dhrme_anc.txt"
