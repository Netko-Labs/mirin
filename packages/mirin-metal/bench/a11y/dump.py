#!/usr/bin/python3
"""Print an application's whole AT-SPI tree, one node a line: what a screen
reader can read of it (role, name, states, extents in window coordinates,
actions, text). For comparing two hosts on the same steps (the tree must be
the same, to the byte).

    python3 bench/a11y/dump.py "<app name>"

The app is named by its first window's title, or `appName`."""

import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402


def line(node, depth):
    parts = ["  " * depth + node.get_role_name()]
    name = node.get_name()
    if name:
        parts.append(repr(name))
    description = node.get_description()
    if description:
        parts.append("desc=" + repr(description))
    states = sorted(state.value_nick for state in node.get_state_set().get_states())
    parts.append("[" + ",".join(states) + "]")
    try:
        extents = node.get_extents(Atspi.CoordType.WINDOW)
        parts.append(f"@{extents.x},{extents.y} {extents.width}x{extents.height}")
    except GLib.Error:
        parts.append("@none")
    try:
        actions = node.get_n_actions()
        if actions:
            names = (node.get_action_name(index) for index in range(actions))
            parts.append("actions=" + ",".join(names))
    except GLib.Error:
        pass
    text = node.get_text_iface()
    if text is not None:
        parts.append("text=" + repr(text.get_text(0, text.get_character_count())))
    return " ".join(parts)


def walk(node, depth, out):
    out.append(line(node, depth))
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            walk(child, depth + 1, out)


desktop = Atspi.get_desktop(0)
for index in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(index)
    if app is not None and app.get_name() == sys.argv[1]:
        lines = []
        walk(app, 0, lines)
        print("\n".join(lines))
        break
else:
    print("no application named", sys.argv[1])
    sys.exit(1)
