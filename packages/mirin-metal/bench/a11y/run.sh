#!/bin/sh
# Run a command with accessibility off, on, or on with something listening,
# without touching the person's own session:
#
#   bench/a11y/run.sh <off|on|at> <listener-out> <command…>
#   bench/a11y/run.sh on /dev/null bun bench/stress.tsx <host> --visible
#
#   off  org.a11y.Status.IsEnabled is false: toolkits leave accessibility off
#   on   IsEnabled is true, and nothing but the registry is on the
#        accessibility bus (a session where a screen reader ran once)
#   at   on, plus `listen.py`: registered for the events a screen reader
#        listens to, asking each event's source what it is; what it heard is
#        written to <listener-out> when the command ends
#
# The command runs on a private session bus that starts no services, with a
# private accessibility bus and registry and a stand-in for
# at-spi-bus-launcher (`status.py`), in a runtime directory of its own. The
# compositor is the one it was started under. `dump.py <app name>` prints an
# application's whole AT-SPI tree from inside such a run.
#
# Needs dbus-daemon, at-spi2-core's registry, and python3 with PyGObject
# (Atspi 2.0).
mode="$1"; out="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"
run="$(mktemp -d "${TMPDIR:-/tmp}/metal-a11y.XXXXXX")"
for registry in /usr/libexec/at-spi2-registryd /usr/lib/at-spi2-core/at-spi2-registryd \
  /usr/lib/at-spi2-registryd; do
  [ -x "$registry" ] && break
done
# The compositor's socket lives in the real runtime directory: name it whole.
case "$WAYLAND_DISPLAY" in
  /* | "") ;;
  *) export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ;;
esac
cat > "$run/session.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:dir=$run</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
export XDG_RUNTIME_DIR="$run" GSETTINGS_BACKEND=memory
export A11Y_MODE="$mode" A11Y_OUT="$out" A11Y_HERE="$here" A11Y_REGISTRY="$registry"
exec dbus-run-session --config-file="$run/session.conf" -- sh -c '
  dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf --nofork \
    --address="unix:path=$XDG_RUNTIME_DIR/a11y-bus" >/dev/null 2>&1 & bus=$!
  export AT_SPI_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/a11y-bus"
  sleep 0.3
  "$A11Y_REGISTRY" >/dev/null 2>&1 & registry=$!
  enabled=true; [ "$A11Y_MODE" = off ] && enabled=false
  python3 -I "$A11Y_HERE/status.py" $enabled & status=$!
  sleep 0.5
  listener=
  if [ "$A11Y_MODE" = at ]; then
    python3 -I "$A11Y_HERE/listen.py" "$A11Y_OUT" & listener=$!
    sleep 0.5
  fi
  "$@"; code=$?
  [ -n "$listener" ] && kill -TERM $listener && sleep 0.5
  kill $status $registry $bus 2>/dev/null
  rm -rf "$XDG_RUNTIME_DIR"
  exit $code
' sh "$@"
