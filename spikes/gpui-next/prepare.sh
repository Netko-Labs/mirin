#!/bin/sh
# Make the spike's copy of mirin-metal's sources: `crates/mirin-metal/{src,examples}`
# as of the commit the port was written against, with `port.patch` applied on
# top. Both directories are generated (ignored by git); `port.patch` is the
# whole port, and the list of what differs on upstream GPUI.
#
#   ./prepare.sh           write ./src and ./examples
#   ./prepare.sh --diff    rewrite port.patch from the current ./src (after editing it)
set -eu

BASE=5fbcfb7e2690ec646f6daa079593eb6436a17586 # perf-gpui-next's starting point (round 1)
cd "$(dirname "$0")"
REPO=$(git rev-parse --show-toplevel)

pristine() {
    git -C "$REPO" archive "$BASE" crates/mirin-metal/src crates/mirin-metal/examples |
        tar -x -C "$1" --strip-components=2
}

if [ "${1:-}" = "--diff" ]; then
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    mkdir "$work/a" "$work/b"
    pristine "$work/a"
    cp -r src "$work/b/src"
    # Relative labels and no timestamps, so the patch is stable.
    (cd "$work" && diff -ruN a/src b/src || [ $? -eq 1 ]) |
        sed -E "s/^((---|\\+\\+\\+) [ab]\\/[^\t]*)\t.*/\\1/" >port.patch
    echo "port.patch: $(grep -c '^+[^+]' port.patch) lines added, $(grep -c '^-[^-]' port.patch) removed"
    exit 0
fi

rm -rf src examples
pristine .
patch -s -p1 <port.patch
echo "src/ and examples/ are crates/mirin-metal at $(echo "$BASE" | cut -c1-7) plus port.patch"
