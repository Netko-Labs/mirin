import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  bundledCodecPath,
  formatProcessIdentity,
  isProcessToken,
  parseProcessIdentity,
  processIdentity,
  type UpdateProcessIdentity,
} from "./update-process.ts";

const HANDOFF_FILE = ".update-handoff.json";
const PHASE_FILE_PREFIX = ".update-phase-";
const RECOVERY_CLAIM_PREFIX = ".update-recovery-claim-";
const MAX_HANDOFF_BYTES = 4096;
const MAX_PHASE_BYTES = 32;
const MAX_VERSION_BYTES = 16 * 1024;
const HANDOFF_TOKEN = /^[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const READY_FILE = /^\.update-ready-[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const RECOVERY_CLAIM =
  /^\.update-recovery-claim-([1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})--([1-9]\d*)-([0-9a-f]{64})$/;

export const HOST_RUNTIME_PROTOCOL = 1;
export const EXCLUSIVE_UPDATER_CAPABILITY = "exclusive-app-lock-v1";
export const UPDATE_HANDOFF_TOKEN_ENV = "MIRIN_UPDATE_HANDOFF_TOKEN";
export const MAX_UPDATE_HANDOFF_AGE_MS = 24 * 60 * 60 * 1000;

interface UpdateHandoffMarker {
  token: string;
  targetVersion: string;
  sourceVersion?: string;
  ownerPid: number;
  ownerToken: string;
  createdAtMs: number;
  helperPid?: number;
  helperToken?: string;
  runningApp?: string;
  staged?: string;
  backup?: string;
  phasePath?: string;
}

interface RecoveryClaim {
  path: string;
  token: string;
  ownerPid: number;
  ownerTokenHash: string;
}

export interface PreparedUpdateHandoff extends UpdateHandoffMarker {
  markerPath: string;
  readyPath: string;
  replacementPath: string;
}

export type UpdateHandoffPhase =
  | "prepared"
  | "activated"
  | "swap-pending"
  | "backup-pending"
  | "backed-up"
  | "launching"
  | "committed";

export interface UpdateHandoffTransaction {
  sourceVersion: string;
  runningApp: string;
  staged: string;
  backup?: string;
}

export interface UpdateHandoffRecovery {
  mode: "rollback" | "commit";
  token: string;
  markerPath: string;
  phasePath: string;
  readyPath: string;
  replacementPath: string;
  runningApp: string;
  staged: string;
  backup: string;
  restorePath?: string;
  owner: UpdateProcessIdentity;
  replacement?: UpdateProcessIdentity;
  claimPaths: string[];
}

export interface UpdateHandoffDecision {
  blocked: boolean;
  readyPath?: string;
  recovery?: UpdateHandoffRecovery;
}

/** Keep updater reservations beside the native app lock, outside replaceable app files. */
export function instanceStateDirectory(identifier: string, dev = false): string {
  const safeIdentifier =
    Array.from(identifier)
      .map((character) => (/[\p{L}\p{N}._-]/u.test(character) ? character : "_"))
      .join("") || "app";
  const suffix = dev ? "-dev" : "";
  if (process.platform === "darwin") {
    return join(
      process.env.HOME ?? "/tmp",
      "Library",
      "Application Support",
      "mirin",
      `${safeIdentifier}${suffix}`,
    );
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? "C:\\Temp";
    return join(base, "mirin", `${safeIdentifier}${suffix}`);
  }
  const base = process.env.XDG_CACHE_HOME || join(process.env.HOME ?? "/tmp", ".cache");
  return join(base, "mirin", `${safeIdentifier}${suffix}`);
}

export function prepareUpdateHandoff(
  identifier: string,
  targetVersion: string,
  directory = instanceStateDirectory(identifier),
  createdAtMs = Date.now(),
  transaction?: UpdateHandoffTransaction,
  owner = processIdentity(process.pid),
): PreparedUpdateHandoff {
  if (!validTimestamp(createdAtMs)) throw new Error("invalid updater handoff timestamp");
  if (!owner || owner.pid !== process.pid) {
    throw new Error("could not bind updater handoff to the current process");
  }
  mkdirSync(directory, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const markerPath = join(directory, HANDOFF_FILE);
  const readyPath = join(directory, `.update-ready-${token}`);
  const replacementPath = replacementIdentityPath(directory, token);
  const phasePath = join(directory, `${PHASE_FILE_PREFIX}${token}`);
  removeFileBestEffort(readyPath);
  removeFileBestEffort(replacementPath);
  const marker: UpdateHandoffMarker = {
    token,
    targetVersion,
    ownerPid: owner.pid,
    ownerToken: owner.token,
    createdAtMs,
    ...(transaction
      ? {
          sourceVersion: transaction.sourceVersion,
          runningApp: resolve(transaction.runningApp),
          staged: resolve(transaction.staged),
          backup: resolve(
            transaction.backup ?? `${resolve(transaction.runningApp)}.mirin-old-${token}`,
          ),
          phasePath,
        }
      : {}),
  };
  const markerExisted = existsSync(markerPath);
  const phaseExisted = existsSync(phasePath);
  try {
    writeDurableInitialFile(markerPath, serializeMarker(marker));
    if (transaction) writeDurableReplacement(phasePath, "prepared");
    return { ...marker, markerPath, readyPath, replacementPath };
  } catch (error) {
    if (!markerExisted) removeFileBestEffort(markerPath);
    if (!phaseExisted) removeFileBestEffort(phasePath);
    throw error;
  }
}

export function activateUpdateHandoff(
  handoff: PreparedUpdateHandoff,
  helper: UpdateProcessIdentity,
): void {
  if (!validPid(helper.pid) || !isProcessToken(helper.token)) {
    throw new Error("updater helper returned an invalid process identity");
  }
  const current = readMarker(handoff.markerPath);
  if (
    !current ||
    current.token !== handoff.token ||
    current.ownerPid !== process.pid ||
    current.ownerToken !== handoff.ownerToken
  ) {
    throw new Error("updater handoff reservation changed before helper activation");
  }
  writeDurableReplacement(
    handoff.markerPath,
    serializeMarker({ ...current, helperPid: helper.pid, helperToken: helper.token }),
  );
  handoff.helperPid = helper.pid;
  handoff.helperToken = helper.token;
}

export function activateUpdateRecovery(
  recovery: UpdateHandoffRecovery,
  helper: UpdateProcessIdentity,
): void {
  if (!validPid(helper.pid) || !isProcessToken(helper.token)) {
    throw new Error("updater recovery helper returned an invalid process identity");
  }
  const current = readMarker(recovery.markerPath);
  if (
    !current ||
    current.token !== recovery.token ||
    current.ownerPid !== recovery.owner.pid ||
    current.ownerToken !== recovery.owner.token
  ) {
    throw new Error("updater recovery reservation changed before helper activation");
  }
  writeDurableReplacement(
    recovery.markerPath,
    serializeMarker({ ...current, helperPid: helper.pid, helperToken: helper.token }),
  );
}

export function abandonUpdateHandoff(handoff: PreparedUpdateHandoff): void {
  const current = readMarker(handoff.markerPath);
  if (current?.token === handoff.token) removeFileBestEffort(handoff.markerPath);
  removeFileBestEffort(handoff.replacementPath);
  removeFileBestEffort(handoff.readyPath);
  if (handoff.phasePath) removeFileBestEffort(handoff.phasePath);
}

/**
 * Decide whether this launch may cross an active updater reservation.
 * Only the staged target version may acquire the native lock while its parent
 * or helper is alive. Stale standalone reservations are removed fail-open to
 * the OS lock, while any surviving recovery claim keeps inspection fail-safe.
 */
export function inspectUpdateHandoff(
  identifier: string,
  resourcesDir: string,
  dev = false,
  launchToken?: string,
  getProcessIdentity: (pid: number) => UpdateProcessIdentity | undefined = (pid) =>
    processIdentity(pid, bundledCodecPath()),
  directory = instanceStateDirectory(identifier, dev),
  nowMs = Date.now(),
): UpdateHandoffDecision {
  const markerPath = join(directory, HANDOFF_FILE);
  if (!existsSync(markerPath)) {
    if (restoreOrphanedRecoveryClaim(directory, markerPath, getProcessIdentity) === "active") {
      return { blocked: true };
    }
    if (!existsSync(markerPath)) {
      return recoveryClaimPaths(directory).length > 0 ? { blocked: true } : { blocked: false };
    }
  }
  let marker = readMarker(markerPath);
  if (!marker) {
    removeFileBestEffort(markerPath);
    if (restoreOrphanedRecoveryClaim(directory, markerPath, getProcessIdentity) === "active") {
      return { blocked: true };
    }
    marker = readMarker(markerPath);
    if (!marker) {
      return recoveryClaimPaths(directory).length > 0 ? { blocked: true } : { blocked: false };
    }
  }

  const readyPath = join(directory, `.update-ready-${marker.token}`);
  const replacementPath = replacementIdentityPath(directory, marker.token);
  const replacement = readProcessIdentityReceipt(replacementPath);
  const replacementStateIsUnreadable = existsSync(replacementPath) && !replacement;
  const active =
    getProcessIdentity(marker.ownerPid)?.token === marker.ownerToken ||
    (marker.helperPid !== undefined &&
      marker.helperToken !== undefined &&
      getProcessIdentity(marker.helperPid)?.token === marker.helperToken) ||
    replacementStateIsUnreadable ||
    (replacement !== undefined && getProcessIdentity(replacement.pid)?.token === replacement.token);
  const launchedTarget =
    launchToken === marker.token && installedVersion(resourcesDir) === marker.targetVersion;
  if (active) {
    return launchedTarget ? { blocked: false, readyPath } : { blocked: true };
  }

  const owner = getProcessIdentity(process.pid);
  if (!owner || owner.pid !== process.pid || !isProcessToken(owner.token)) {
    return { blocked: true };
  }
  const claimPath = join(
    directory,
    `${RECOVERY_CLAIM_PREFIX}${marker.token}--${owner.pid}-${processTokenHash(owner.token)}`,
  );
  try {
    renameSync(markerPath, claimPath);
    syncNamespace(claimPath);
  } catch {
    // Another bootstrap either claimed or refreshed the marker after our read.
    return { blocked: true };
  }
  const claimedMarker = readMarker(claimPath);
  if (!claimedMarker) {
    removeFileBestEffort(claimPath);
    return { blocked: false };
  }
  marker = claimedMarker;
  const claimPaths = recoveryClaimPaths(directory, marker.token);
  const claimedReplacementPath = replacementIdentityPath(directory, marker.token);
  const claimedReplacement = readProcessIdentityReceipt(claimedReplacementPath);
  const claimedReplacementStateIsUnreadable =
    existsSync(claimedReplacementPath) && !claimedReplacement;
  const claimedActive =
    getProcessIdentity(marker.ownerPid)?.token === marker.ownerToken ||
    (marker.helperPid !== undefined &&
      marker.helperToken !== undefined &&
      getProcessIdentity(marker.helperPid)?.token === marker.helperToken) ||
    claimedReplacementStateIsUnreadable ||
    (claimedReplacement !== undefined &&
      getProcessIdentity(claimedReplacement.pid)?.token === claimedReplacement.token);
  const claimedReadyPath = join(directory, `.update-ready-${marker.token}`);
  const claimedTarget =
    launchToken === marker.token && installedVersion(resourcesDir) === marker.targetVersion;
  if (claimedActive) {
    restoreClaimedMarker(markerPath, claimPath);
    return claimedTarget ? { blocked: false, readyPath: claimedReadyPath } : { blocked: true };
  }

  if (!markerTransactionIsValid(marker, resourcesDir, directory)) {
    removeFilesBestEffort(claimPaths);
    removeFileBestEffort(claimedReplacementPath);
    removeFileBestEffort(claimedReadyPath);
    return { blocked: false };
  }

  const phase = readPhase(marker.phasePath);
  const installed = installedVersion(resourcesDir);

  if (installed === marker.sourceVersion) {
    if (
      !removeOwnedDirectoryBestEffort(marker.staged) ||
      !removeOwnedDirectoryBestEffort(marker.backup)
    ) {
      restoreClaimedMarker(markerPath, claimPath);
      return { blocked: true };
    }
    removeFilesBestEffort(claimPaths);
    removeFileBestEffort(claimedReplacementPath);
    removeFileBestEffort(marker.phasePath);
    removeFileBestEffort(claimedReadyPath);
    return { blocked: false };
  }
  if (!phase || installed !== marker.targetVersion) {
    restoreClaimedMarker(markerPath, claimPath);
    return { blocked: true };
  }

  const restorePath = realDirectory(marker.backup) ?? realDirectory(marker.staged) ?? undefined;
  const mode = phase === "committed" ? "commit" : "rollback";
  if (mode === "rollback" && !restorePath) {
    restoreClaimedMarker(markerPath, claimPath);
    return { blocked: true };
  }

  try {
    writeDurableInitialFile(
      markerPath,
      serializeMarker({
        ...marker,
        ownerPid: owner.pid,
        ownerToken: owner.token,
        helperPid: undefined,
        helperToken: undefined,
        createdAtMs: validTimestamp(nowMs) ? nowMs : marker.createdAtMs,
      }),
    );
  } catch {
    // A marker link can become visible before its parent sync reports failure.
    // Preserve the claim regardless so a later bootstrap always has a durable
    // journal to restore or use to validate the visible marker.
    return { blocked: true };
  }
  return {
    blocked: false,
    recovery: {
      mode,
      token: marker.token,
      markerPath,
      phasePath: marker.phasePath,
      readyPath: claimedReadyPath,
      replacementPath: claimedReplacementPath,
      runningApp: marker.runningApp,
      staged: marker.staged,
      backup: marker.backup,
      ...(restorePath ? { restorePath } : {}),
      owner,
      ...(claimedReplacement ? { replacement: claimedReplacement } : {}),
      claimPaths,
    },
  };
}

/** Write the durable receipt consumed by the helper after the app reports ready. */
export function signalUpdateReady(
  readyPath: string,
  identity = processIdentity(process.pid),
): void {
  if (!READY_FILE.test(basename(readyPath))) {
    throw new Error("invalid updater readiness path");
  }
  if (!identity || identity.pid !== process.pid) {
    throw new Error("could not bind updater readiness to the current process");
  }
  const token = basename(readyPath).slice(".update-ready-".length);
  const receipt = formatProcessIdentity(identity);
  writeDurableReplacement(replacementIdentityPath(dirname(readyPath), token), receipt);
  writeDurableReplacement(readyPath, receipt);
}

function serializeMarker(marker: UpdateHandoffMarker): string {
  return JSON.stringify(marker);
}

function readMarker(path: string): UpdateHandoffMarker | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_HANDOFF_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (
      keys.some(
        (key) =>
          ![
            "token",
            "targetVersion",
            "sourceVersion",
            "ownerPid",
            "ownerToken",
            "createdAtMs",
            "helperPid",
            "helperToken",
            "runningApp",
            "staged",
            "backup",
            "phasePath",
          ].includes(key),
      ) ||
      !HANDOFF_TOKEN.test(String(source.token ?? "")) ||
      typeof source.targetVersion !== "string" ||
      source.targetVersion.length === 0 ||
      source.targetVersion.length > 128 ||
      !validPid(source.ownerPid) ||
      !isProcessToken(source.ownerToken) ||
      !validTimestamp(source.createdAtMs) ||
      (source.helperPid !== undefined && !validPid(source.helperPid)) ||
      (source.helperToken !== undefined && !isProcessToken(source.helperToken)) ||
      (source.helperPid === undefined) !== (source.helperToken === undefined) ||
      !validOptionalString(source.sourceVersion, 128) ||
      !validOptionalString(source.runningApp, 2048) ||
      !validOptionalString(source.staged, 2048) ||
      !validOptionalString(source.backup, 2048) ||
      !validOptionalString(source.phasePath, 2048)
    ) {
      return undefined;
    }
    return {
      token: source.token as string,
      targetVersion: source.targetVersion,
      ...(source.sourceVersion === undefined ? {} : { sourceVersion: source.sourceVersion }),
      ownerPid: source.ownerPid,
      ownerToken: source.ownerToken,
      createdAtMs: source.createdAtMs,
      ...(source.helperPid === undefined ? {} : { helperPid: source.helperPid }),
      ...(source.helperToken === undefined ? {} : { helperToken: source.helperToken }),
      ...(source.runningApp === undefined ? {} : { runningApp: source.runningApp }),
      ...(source.staged === undefined ? {} : { staged: source.staged }),
      ...(source.backup === undefined ? {} : { backup: source.backup }),
      ...(source.phasePath === undefined ? {} : { phasePath: source.phasePath }),
    } as UpdateHandoffMarker;
  } catch {
    return undefined;
  }
}

function installedVersion(resourcesDir: string): string | undefined {
  try {
    const path = join(resourcesDir, "version.json");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_VERSION_BYTES) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const version = (value as Record<string, unknown>).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function markerTransactionIsValid(
  marker: UpdateHandoffMarker,
  resourcesDir: string,
  stateDirectory: string,
): marker is UpdateHandoffMarker &
  Required<
    Pick<UpdateHandoffMarker, "sourceVersion" | "runningApp" | "staged" | "backup" | "phasePath">
  > {
  if (
    !marker.sourceVersion ||
    !marker.runningApp ||
    !marker.staged ||
    !marker.backup ||
    !marker.phasePath
  ) {
    return false;
  }
  const runningApp =
    process.platform === "darwin" ? resolve(resourcesDir, "..", "..") : resolve(resourcesDir, "..");
  if (resolve(marker.runningApp) !== runningApp) return false;
  const parent = dirname(runningApp);
  const name = basename(runningApp);
  if (dirname(marker.staged) !== parent || dirname(marker.backup) !== parent) return false;
  if (!basename(marker.staged).startsWith(`.${name}.mirin-new-`)) return false;
  if (marker.backup !== `${runningApp}.mirin-old-${marker.token}`) return false;
  return (
    resolve(marker.phasePath) === resolve(stateDirectory, `${PHASE_FILE_PREFIX}${marker.token}`)
  );
}

function readPhase(path: string): UpdateHandoffPhase | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_PHASE_BYTES) {
      return undefined;
    }
    const value = readFileSync(path, "utf8");
    return [
      "prepared",
      "activated",
      "swap-pending",
      "backup-pending",
      "backed-up",
      "launching",
      "committed",
    ].includes(value)
      ? (value as UpdateHandoffPhase)
      : undefined;
  } catch {
    return undefined;
  }
}

function readProcessIdentityReceipt(path: string): UpdateProcessIdentity | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 256) return undefined;
    return parseProcessIdentity(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function replacementIdentityPath(directory: string, token: string): string {
  return join(directory, `.update-replacement-${token}`);
}

function validOptionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= maxLength)
  );
}

function realDirectory(path: string): string | undefined {
  try {
    const metadata = lstatSync(path);
    return !metadata.isSymbolicLink() && metadata.isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

function removeOwnedDirectoryBestEffort(path: string): boolean {
  if (!existsSync(path)) return true;
  if (!realDirectory(path)) return false;
  try {
    rmSync(path, { recursive: true });
    return !existsSync(path);
  } catch {
    // A later launch can retry reconciliation while the marker remains.
    return false;
  }
}

function recoveryClaims(directory: string, token?: string): RecoveryClaim[] {
  try {
    return readdirSync(directory)
      .map((entry): RecoveryClaim | undefined => {
        const match = RECOVERY_CLAIM.exec(entry);
        if (!match || (token !== undefined && match[1] !== token)) return undefined;
        const ownerPid = Number(match[2]);
        if (!validPid(ownerPid)) return undefined;
        return {
          path: join(directory, entry),
          token: match[1] as string,
          ownerPid,
          ownerTokenHash: match[3] as string,
        };
      })
      .filter((claim): claim is RecoveryClaim => claim !== undefined)
      .sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

function recoveryClaimPaths(directory: string, token?: string): string[] {
  return recoveryClaims(directory, token).map((claim) => claim.path);
}

function restoreOrphanedRecoveryClaim(
  directory: string,
  markerPath: string,
  getProcessIdentity: (pid: number) => UpdateProcessIdentity | undefined,
): "active" | "restored" | "none" {
  const claims = recoveryClaims(directory);
  if (
    claims.some((claim) => {
      const identity = getProcessIdentity(claim.ownerPid);
      return identity !== undefined && processTokenHash(identity.token) === claim.ownerTokenHash;
    })
  ) {
    return "active";
  }
  const candidates = claims
    .map((claim) => ({ claim, marker: readMarker(claim.path) }))
    .filter(
      (
        candidate,
      ): candidate is {
        claim: RecoveryClaim;
        marker: UpdateHandoffMarker;
      } => candidate.marker !== undefined,
    )
    .sort((left, right) => right.marker.createdAtMs - left.marker.createdAtMs);
  for (const candidate of candidates) {
    if (existsSync(markerPath)) return "restored";
    try {
      renameSync(candidate.claim.path, markerPath);
      syncNamespace(markerPath);
      return "restored";
    } catch {
      if (existsSync(markerPath)) return "restored";
    }
  }
  return "none";
}

function restoreClaimedMarker(markerPath: string, claimPath: string): void {
  if (existsSync(markerPath) && !readMarker(markerPath)) {
    removeFileBestEffort(markerPath);
  }
  if (!existsSync(markerPath)) {
    try {
      renameSync(claimPath, markerPath);
      syncNamespace(markerPath);
      return;
    } catch {
      if (!existsSync(markerPath)) return;
    }
  }
  if (readMarker(markerPath)) removeFileBestEffort(claimPath);
}

function processTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function removeFilesBestEffort(paths: string[]): void {
  for (const path of paths) removeFileBestEffort(path);
}

function writeDurableInitialFile(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (process.platform === "win32") {
      writeDurableWithCodec(temporary, contents);
    } else {
      writeFileSync(temporary, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      syncFile(temporary);
    }
    linkSync(temporary, path);
    syncNamespace(path);
  } finally {
    removeFileBestEffort(temporary);
  }
}

function writeDurableReplacement(path: string, contents: string): void {
  if (process.platform === "win32") {
    writeDurableWithCodec(path, contents);
    return;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    syncFile(temporary);
    renameSync(temporary, path);
    syncFileAndParent(path);
  } finally {
    removeFileBestEffort(temporary);
  }
}

function writeDurableWithCodec(path: string, contents: string): void {
  const result = Bun.spawnSync([bundledCodecPath(), "durable-write", path, contents], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not durably write updater transaction state");
  }
}

function syncFileAndParent(path: string): void {
  syncFile(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Windows does not expose directory handles through node:fs. Flushing the
    // final file handle still makes its contents and current namespace durable.
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncNamespace(path: string): void {
  if (process.platform !== "win32") {
    syncFileAndParent(path);
    return;
  }
  const result = Bun.spawnSync([bundledCodecPath(), "sync-parent", path], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error("could not make updater namespace transition durable");
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeFileBestEffort(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A stale receipt/marker is recoverable on the next launch.
  }
}
