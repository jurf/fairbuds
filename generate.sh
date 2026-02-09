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
    "../presets/rtings_treble.txt"

python ../scripts/compensate.py rtings_treble.txt

# Under -4 dB preamp the algorithm has a dramatically different response
# with much less emphasis in the treble.
# Still, someone might prefer more accurate bass
python -m autoeq \
    --input-file="../measurements/RTINGS (main eq, ANC Off).csv" \
    --output-dir="../results" \
    --target="targets/JM-1 with Harman filters.csv" \
    --max-gain=8 \
    --parametric-eq \
    --parametric-eq-config=../pex/fairbuds.yaml \
    --fs=48000 \
    --bass-boost=6.5 \
    --preamp=-3.9

cp "../results/RTINGS (main eq, ANC Off)/RTINGS (main eq, ANC Off) ParametricEQ.txt" \
    "../presets/rtings_bass.txt"

python ../scripts/compensate.py rtings_bass.txt