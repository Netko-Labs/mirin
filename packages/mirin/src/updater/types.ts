export type UpdaterStatus =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "applying"
  | "complete"
  | "error";

/** The running app's embedded identity (Resources/version.json). */
export interface VersionInfo {
  version: string;
  channel: string;
  baseUrl: string;
  name: string;
  identifier: string;
  /** Raw base64 Ed25519 public key. When set, the updater rejects any manifest
   *  without a valid detached signature from the matching private key. */
  publicKey?: string;
  /** macOS Team ID (certificate OU) the downloaded update's code signature is
   *  pinned to. Defence in depth alongside `publicKey`. */
  teamId?: string;
}

export interface UpdateArtifact {
  url: string;
  sha256: string;
  size?: number;
}

export interface UpdatePatch extends UpdateArtifact {
  fromVersion: string;
}

/** The published-release manifest ({prefix}-update.json). */
export interface Manifest {
  version: string;
  channel: string;
  platform: string;
  arch: string;
  /** Optional markdown release notes shown by app UIs. */
  body?: string;
  /** SHA-256 of the uncompressed bundle tar (update identity + integrity). */
  tarHash: string;
  bundle: UpdateArtifact;
  patches?: UpdatePatch[];
}

/** A published release the running app can update to. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  channel: string;
  /** Optional markdown release notes from the update manifest. */
  body?: string;
}

export interface UpdateProgress {
  received: number;
  total: number;
  /** 0..1 (0 when total is unknown). */
  fraction: number;
}

export type UpdaterEvents = {
  status: { status: UpdaterStatus };
  progress: UpdateProgress;
  "update-available": UpdateInfo;
  error: { message: string };
};

export type Listener<P> = (payload: P) => void;
