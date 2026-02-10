set -e

python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC Off).csv" \
    --output-dir="../results" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=48000 \
    --bass-boost=8 \
    --preamp=-2.4

cp "../results/DHRME (studio eq, ANC Off)/DHRME (studio eq, ANC Off) ParametricEQ.txt" \
    "../presets/dhrme.txt"

python -m autoeq \
    --input-file="../measurements/DHRME (studio eq, ANC On).csv" \
    --output-dir="../results" \
    --target="targets/AutoEq in-ear.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=48000 \
    --bass-boost=8 \
    --preamp=-2

cp "../results/DHRME (studio eq, ANC On)/DHRME (studio eq, ANC On) ParametricEQ.txt" \
    "../presets/dhrme_anc.txt"

# This one is really picky. It's possible a better EQ will be found in the future with
# different constraints
python -m autoeq \
    --input-file="../measurements/RTINGS (main eq, ANC Off).csv" \
    --output-dir="../results" \
    --target="targets/JM-1 with Harman filters.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=48000 \
    --bass-boost=6.5 \
    --preamp=-4

cp "../results/RTINGS (main eq, ANC Off)/RTINGS (main eq, ANC Off) ParametricEQ.txt" \
    "../presets/rtings.txt"

# The treble boost produces some unwanted spikes, tone it down
python ../scripts/compensate.py ../presets/rtings.txt --override 8:-1
