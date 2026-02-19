set -e

python -m autoeq \
    --input-file="../measurements/RTINGS (main eq, ANC Off).csv" \
    --output-dir="../results_app" \
    --target="targets/JM-1 with Harman treble filter.csv" \
    --max-gain=12 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --sound-signature=../signatures/reconstructed.csv \
    --sound-signature-smoothing-window-size=0 \
    --fs=44100 \
    --treble-boost=-3 \
    --bass-boost=6.5 \
    --preamp=0

cp "../results_app/RTINGS (main eq, ANC Off)/RTINGS (main eq, ANC Off) ParametricEQ.txt" \
    "../presets_app/rtings.txt"


python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC Off).csv" \
    --output-dir="../results_app" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=12 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --fs=44100 \
    --bass-boost=8 \
    --preamp=-2.4

cp "../results_app/DHRME (studio eq, ANC Off)/DHRME (studio eq, ANC Off) ParametricEQ.txt" \
    "../presets_app/dhrme.txt"


python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC On).csv" \
    --output-dir="../results_app" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=12 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --fs=44100 \
    --bass-boost=8 \
    --preamp=0.6

cp "../results_app/DHRME (studio eq, ANC On)/DHRME (studio eq, ANC On) ParametricEQ.txt" \
    "../presets_app/dhrme_anc.txt"