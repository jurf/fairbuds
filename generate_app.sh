set -e

python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC Off).csv" \
    --output-dir="../results_app" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --fs=48000 \
    --bass-boost=8 \
    --preamp=-1

cp "../results_app/DHRME (studio eq, ANC Off)/DHRME (studio eq, ANC Off) ParametricEQ.txt" \
    "../presets_app/dhrme.txt"

python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC On).csv" \
    --output-dir="../results_app" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=9 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --fs=48000 \
    --bass-boost=8 \
    --preamp=-4

cp "../results_app/DHRME (studio eq, ANC On)/DHRME (studio eq, ANC On) ParametricEQ.txt" \
    "../presets_app/dhrme_anc.txt"

python -m autoeq \
    --input-file="../measurements/RTINGS (main eq, ANC Off).csv" \
    --output-dir="../results_app" \
    --target="targets/JM-1 with Harman filters.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds_app.yaml \
    --fs=48000 \
    --bass-boost=6.5 \
    --preamp=-2.9

cp "../results_app/RTINGS (main eq, ANC Off)/RTINGS (main eq, ANC Off) ParametricEQ.txt" \
    "../presets_app/rtings.txt"

python ../scripts/compensate.py ../presets_app/rtings.txt
