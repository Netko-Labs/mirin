#!/bin/sh
# Count the signals sent on the accessibility bus while a command runs, by
# kind, whoever listens (a monitor hears them all): inside `run.sh`,
#
#   bench/a11y/run.sh on /dev/null bench/a11y/signals.sh <out> <command…>
#
# writes "<count> <member>" lines to <out>, most first. With a bench of one
# scenario (`bun bench/stress.tsx <host> --visible --only=scroll`), the
# count over its updates is what each tells the bus.
out="$1"; shift
dbus-monitor --address "$AT_SPI_BUS_ADDRESS" "type='signal'" > "$out.raw" 2>/dev/null &
monitor=$!
sleep 0.3
"$@"; code=$?
sleep 0.5
kill $monitor 2>/dev/null
awk '/^signal/ { for (i = 1; i <= NF; i++) if ($i ~ /^member=/) count[substr($i, 8)]++ }
  END { for (member in count) print count[member], member }' "$out.raw" | sort -rn > "$out"
rm -f "$out.raw"
exit $code
