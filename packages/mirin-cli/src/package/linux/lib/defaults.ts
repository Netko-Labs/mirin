import type { LinuxPackageFormat } from "../types.ts";

/** CEF/GTK runtime deps on Debian/Ubuntu package naming (best-effort; overridable). */
export const DEFAULT_DEB_DEPENDS = [
  "libgtk-3-0",
  "libnss3",
  "libnspr4",
  "libasound2",
  "libx11-6",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libxkbcommon0",
  "libpango-1.0-0",
  "libcairo2",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libdrm2",
  "libdbus-1-3",
];

/** CEF/GTK runtime deps on RPM (Fedora/RHEL/openSUSE) package naming. */
export const DEFAULT_RPM_DEPENDS = [
  "gtk3",
  "nss",
  "nspr",
  "alsa-lib",
  "libX11",
  "libXcomposite",
  "libXdamage",
  "libXext",
  "libXfixes",
  "libXrandr",
  "mesa-libgbm",
  "libxkbcommon",
  "pango",
  "cairo",
  "atk",
  "at-spi2-atk",
  "cups-libs",
  "libdrm",
  "dbus-libs",
];

export const LINUX_FORMATS = [
  "appimage",
  "deb",
  "rpm",
] as const satisfies readonly LinuxPackageFormat[];
