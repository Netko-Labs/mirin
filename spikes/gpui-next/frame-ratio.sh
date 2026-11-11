#!/bin/sh
# From stress-bench traces (`bun bench/stress.tsx <host> --trace=<path>`): the
# median `render` (mirin-metal building its elements: the same code on every
# host, so a yardstick for how loaded the machine was), the median `frame`
# (GPUI's layout, prepaint and paint), and the median of frame / render per
# frame, which is what to compare between hosts on a shared machine.
#
#   ./frame-ratio.sh <trace>...
set -eu

median() { sort -n | awk '{ v[NR] = $1 } END { if (NR) printf "%.1f", v[int((NR + 1) / 2)] }'; }

for trace in "$@"; do
    # The first frames lay the whole tree out for the first time: skip them.
    lines=$(grep -o 'render [0-9x]* took [0-9.]*ms, frame [0-9.]*ms' "$trace" | tail -n +5)
    render=$(echo "$lines" | awk '{ print $4 + 0 }' | median)
    frame=$(echo "$lines" | awk '{ print $6 + 0 }' | median)
    ratio=$(echo "$lines" | awk '{ if ($4 + 0 > 0) print ($6 + 0) / ($4 + 0) }' | median)
    printf '%s: render %s ms, frame %s ms, frame/render %s (%s frames)\n' \
        "$trace" "$render" "$frame" "$ratio" "$(echo "$lines" | wc -l)"
done
