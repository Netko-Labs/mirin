#!/usr/bin/python3
"""A minimal assistive technology for benchmarks (`run.sh at`): registers for
the events a screen reader listens to, asks each event's source what it is
(role, name, states), reads the top of each application's tree once, and on
SIGTERM writes how many events of each kind it heard to argv[1]."""

import signal
import sys
import warnings

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

warnings.simplefilter("ignore")
counts = {}
seen = {}


def read(node, depth=0):
    """The application, its windows and the first of their children."""
    read_nodes = 1
    try:
        node.get_role()
        node.get_name()
        if depth < 2:
            for index in range(min(node.get_child_count(), 20)):
                child = node.get_child_at_index(index)
                if child is not None:
                    read_nodes += read(child, depth + 1)
    except GLib.Error:
        pass
    return read_nodes


def on_event(event):
    counts[event.type] = counts.get(event.type, 0) + 1
    try:
        source = event.source
        source.get_role()
        source.get_name()
        source.get_state_set()
        app = source.get_application()
        name = app.get_name() if app else None
    except GLib.Error:
        return
    if name and name not in seen and event.type.startswith("object:children-changed"):
        seen[name] = 0
        seen[name] = read(app)


def summary(*_):
    with open(sys.argv[1], "w", encoding="utf-8") as out:
        out.write(f"applications read (nodes): {seen}\n")
        for kind, heard in sorted(counts.items(), key=lambda item: -item[1]):
            out.write(f"{heard:8d} {kind}\n")
    Atspi.event_quit()
    return False


listener = Atspi.EventListener.new(on_event)
for kind in [
    "object:state-changed",
    "object:children-changed",
    "object:property-change",
    "object:text-changed",
    "object:text-caret-moved",
    "object:bounds-changed",
    "object:active-descendant-changed",
    "object:selection-changed",
    "window:activate",
    "window:deactivate",
    "window:create",
    "focus:",
]:
    listener.register(kind)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, summary)
Atspi.event_main()
