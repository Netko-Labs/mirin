import type { LinuxConfig, LinuxPackageFormat } from "mirinjs";

export type { LinuxConfig, LinuxPackageFormat };

export interface LinuxPackageInput {
  /** The assembled Linux app folder (build/<App>): the whole relocatable payload. */
  appDir: string;
  /** App display name; also the host-binary stem inside `appDir`. */
  appName: string;
  /** Reverse-DNS app id, e.g. "dev.netko.anko" (install prefix + `.desktop`/icon name). */
  bundleId: string;
  version: string;
  /** Publisher / company (deb/rpm vendor + maintainer fallback). */
  publisher: string;
  /** Directory the artifacts are written into. */
  outDir: string;
  projectDir: string;
  /** Abs path to the app icon source (`.png` / `.iconset`); resolved to a PNG. */
  icon?: string;
  /** Resolved Linux config (maintainer, depends, category, ...). */
  options: LinuxConfig;
  /** Which formats to build. */
  formats: LinuxPackageFormat[];
}

export interface LinuxPackageResult {
  format: LinuxPackageFormat;
  path: string;
  size: number;
}
