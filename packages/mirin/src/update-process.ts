import { dirname, join } from "node:path";

const PROCESS_TOKEN = /^[0-9A-Za-z._:-]{1,128}$/;
const PROCESS_RECEIPT = /^([1-9]\d*)\|([0-9A-Za-z._:-]{1,128})$/;

export interface UpdateProcessIdentity {
  pid: number;
  token: string;
}

export function bundledCodecPath(executable = process.execPath): string {
  return join(
    dirname(executable),
    process.platform === "win32" ? "mirin-codec.exe" : "mirin-codec",
  );
}

export function processIdentity(
  pid: number,
  codec = bundledCodecPath(),
): UpdateProcessIdentity | undefined {
  if (!validPid(pid)) return undefined;
  try {
    const result = Bun.spawnSync([codec, "process-token", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0 || result.stdout.byteLength > 256) return undefined;
    const token = result.stdout.toString().trim();
    return PROCESS_TOKEN.test(token) ? { pid, token } : undefined;
  } catch {
    return undefined;
  }
}

export function systemBootToken(codec = bundledCodecPath()): string | undefined {
  try {
    const result = Bun.spawnSync([codec, "boot-token"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0 || result.stdout.byteLength > 256) return undefined;
    const token = result.stdout.toString().trim();
    return PROCESS_TOKEN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function processIdentityMatches(
  expected: UpdateProcessIdentity,
  codec = bundledCodecPath(),
): boolean {
  return processIdentity(expected.pid, codec)?.token === expected.token;
}

export function formatProcessIdentity(identity: UpdateProcessIdentity): string {
  if (!validPid(identity.pid) || !PROCESS_TOKEN.test(identity.token)) {
    throw new Error("invalid updater process identity");
  }
  return `${identity.pid}|${identity.token}`;
}

export function parseProcessIdentity(value: string): UpdateProcessIdentity {
  const match = PROCESS_RECEIPT.exec(value.trim());
  if (!match) throw new Error("invalid updater process identity");
  const pid = Number(match[1]);
  if (!validPid(pid)) throw new Error("invalid updater process identity");
  return { pid, token: match[2] as string };
}

export function isProcessToken(value: unknown): value is string {
  return typeof value === "string" && PROCESS_TOKEN.test(value);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
