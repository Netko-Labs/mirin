#!/usr/bin/python3
"""A stand-in for at-spi-bus-launcher on a private session bus (`run.sh`):
owns org.a11y.Bus, answers GetAddress with $AT_SPI_BUS_ADDRESS and
org.a11y.Status.IsEnabled with argv[1] ("true" or "false"). It lets a run
choose whether toolkits see accessibility as on, which on a real session is a
setting the launcher writes back."""

import os
import sys
import warnings

from gi.repository import Gio, GLib

warnings.simplefilter("ignore")
ENABLED = len(sys.argv) > 1 and sys.argv[1] == "true"
ADDRESS = os.environ["AT_SPI_BUS_ADDRESS"]
INFO = Gio.DBusNodeInfo.new_for_xml("""<node>
 <interface name='org.a11y.Bus'>
  <method name='GetAddress'><arg type='s' direction='out'/></method>
 </interface>
 <interface name='org.a11y.Status'>
  <property name='IsEnabled' type='b' access='readwrite'/>
  <property name='ScreenReaderEnabled' type='b' access='readwrite'/>
 </interface>
</node>""")


def call(_conn, _sender, _path, _interface, _method, _params, invocation):
    invocation.return_value(GLib.Variant("(s)", (ADDRESS,)))


def get(_conn, _sender, _path, _interface, name):
    return GLib.Variant("b", ENABLED and name == "IsEnabled")


def set_(_conn, _sender, _path, _interface, _name, _value):
    return False


def acquired(conn, _name):
    for interface in INFO.interfaces:
        conn.register_object("/org/a11y/bus", interface, call, get, set_)


Gio.bus_own_name(
    Gio.BusType.SESSION, "org.a11y.Bus", Gio.BusNameOwnerFlags.NONE, acquired, None, None
)
GLib.MainLoop().run()
