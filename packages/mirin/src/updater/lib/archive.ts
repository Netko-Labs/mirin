import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_LINK_BYTES,
  MAX_ARCHIVE_PATH_BYTES,
  MAX_PAX_HEADER_BYTES,
  MAX_TAR_BYTES,
} from "./limits.ts";

const BLOCK_SIZE = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export type ArchiveEntryKind = "file" | "directory" | "symlink" | "hardlink";

export interface ArchiveEntryDescriptor {
  path: string;
  kind: ArchiveEntryKind;
  linkTarget?: string;
}

interface ExtendedHeader {
  path?: string;
  linkPath?: string;
  size?: number;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function fieldString(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const bytes = nul === -1 ? field : field.subarray(0, nul);
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error("update archive contains a non-UTF-8 header");
  }
}

function octalField(header: Uint8Array, start: number, length: number, label: string): number {
  const field = header.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) throw new Error(`unsupported update archive ${label}`);
  const raw = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid update archive ${label}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid update archive ${label}`);
  }
  return value;
}

function verifyChecksum(header: Uint8Array): void {
  const expected = octalField(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error("invalid update archive checksum");
}

function normalizedArchivePath(raw: string): string | null {
  let value = raw;
  while (value.startsWith("./")) value = value.slice(2);
  if (
    value.length === 0 ||
    value === "." ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    byteLength(value) > MAX_ARCHIVE_PATH_BYTES
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

function resolvedSymlinkTarget(entry: string, rawTarget: string): string | null {
  if (
    rawTarget.length === 0 ||
    rawTarget.includes("\\") ||
    rawTarget.includes("\0") ||
    rawTarget.startsWith("/") ||
    /^[A-Za-z]:/.test(rawTarget) ||
    byteLength(rawTarget) > MAX_ARCHIVE_LINK_BYTES
  ) {
    return null;
  }
  const parts = entry.split("/").slice(0, -1);
  for (const part of rawTarget.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

export function validateArchiveEntries(
  entries: ArchiveEntryDescriptor[],
  expectedRoot: string,
): void {
  const root = normalizedArchivePath(expectedRoot);
  if (!root || root.includes("/")) throw new Error(`invalid update bundle root: ${expectedRoot}`);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("invalid update archive entry count");
  }

  const kinds = new Map<string, ArchiveEntryKind>();
  const hardlinks: Array<{ path: string; target: string }> = [];
  let sawRoot = false;
  for (const rawEntry of entries) {
    const path = normalizedArchivePath(rawEntry.path);
    if (!path) throw new Error(`unsafe update archive entry: ${rawEntry.path}`);
    if (path !== root && !path.startsWith(`${root}/`)) {
      throw new Error(`update archive entry escapes ${root}: ${rawEntry.path}`);
    }
    sawRoot = true;
    if (path === root && rawEntry.kind !== "directory") {
      throw new Error(`update archive root is not a directory: ${rawEntry.path}`);
    }
    const previous = kinds.get(path);
    if (previous && (previous !== "directory" || rawEntry.kind !== "directory")) {
      throw new Error(`duplicate update archive entry: ${path}`);
    }
    kinds.set(path, rawEntry.kind);

    if (rawEntry.kind === "symlink") {
      const target = resolvedSymlinkTarget(path, rawEntry.linkTarget ?? "");
      if (!target || (target !== root && !target.startsWith(`${root}/`))) {
        throw new Error(`update archive symlink escapes ${root}: ${path}`);
      }
    } else if (rawEntry.kind === "hardlink") {
      const target = normalizedArchivePath(rawEntry.linkTarget ?? "");
      if (!target || (target !== root && !target.startsWith(`${root}/`))) {
        throw new Error(`update archive hardlink escapes ${root}: ${path}`);
      }
      hardlinks.push({ path, target });
    } else if (rawEntry.linkTarget !== undefined) {
      throw new Error(`unexpected update archive link target: ${path}`);
    }
  }

  if (!sawRoot) throw new Error(`update archive missing ${root}`);
  for (const hardlink of hardlinks) {
    if (kinds.get(hardlink.target) !== "file") {
      throw new Error(`update archive hardlink target is not a regular file: ${hardlink.path}`);
    }
  }
}

function readAt(fd: number, length: number, position: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const read = readSync(fd, bytes, 0, length, position);
  if (read !== length) throw new Error("truncated update archive");
  return bytes;
}

function roundedBlocks(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

function paxRecords(bytes: Uint8Array): ExtendedHeader {
  const result: ExtendedHeader = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space === -1) throw new Error("invalid update archive PAX header");
    const lengthText = new TextDecoder().decode(bytes.subarray(offset, space));
    if (!/^\d+$/.test(lengthText)) throw new Error("invalid update archive PAX header");
    const length = Number(lengthText);
    const end = offset + length;
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      end > bytes.length ||
      bytes[end - 1] !== 10
    ) {
      throw new Error("invalid update archive PAX header");
    }
    const record = bytes.subarray(space + 1, end - 1);
    const equals = record.indexOf(61);
    if (equals <= 0) throw new Error("invalid update archive PAX record");
    const keyBytes = record.subarray(0, equals);
    if (!keyBytes.every((byte) => byte >= 33 && byte <= 126)) {
      throw new Error("invalid update archive PAX key");
    }
    const key = String.fromCharCode(...keyBytes);
    const valueBytes = record.subarray(equals + 1);
    if (key.startsWith("GNU.sparse.") || key === "SCHILY.filetype") {
      throw new Error(`unsupported update archive PAX feature: ${key}`);
    }
    if (key === "path" || key === "linkpath") {
      let value: string;
      try {
        value = decoder.decode(valueBytes);
      } catch {
        throw new Error("invalid update archive PAX path");
      }
      if (key === "path") result.path = value;
      else result.linkPath = value;
    }
    if (key === "size") {
      const value = String.fromCharCode(...valueBytes);
      if (!/^\d+$/.test(value)) throw new Error("invalid update archive PAX size");
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_BYTES) {
        throw new Error("invalid update archive PAX size");
      }
      result.size = size;
    }
    offset = end;
  }
  return result;
}

function metadataString(bytes: Uint8Array, maximum: number): string {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 10)) end -= 1;
  const value = decoder.decode(bytes.subarray(0, end));
  if (value.length === 0 || byteLength(value) > maximum) {
    throw new Error("invalid update archive long-name header");
  }
  return value;
}

function parseArchive(archive: string): ArchiveEntryDescriptor[] {
  const fd = openSync(archive, "r");
  try {
    const archiveSize = fstatSync(fd).size;
    if (archiveSize <= 0 || archiveSize > MAX_TAR_BYTES) {
      throw new Error("invalid update archive size");
    }

    const entries: ArchiveEntryDescriptor[] = [];
    let pending: ExtendedHeader = {};
    let position = 0;
    while (position + BLOCK_SIZE <= archiveSize) {
      const header = readAt(fd, BLOCK_SIZE, position);
      position += BLOCK_SIZE;
      if (header.every((byte) => byte === 0)) break;
      verifyChecksum(header);

      const headerSize = octalField(header, 124, 12, "entry size");
      const type = String.fromCharCode(header[156] ?? 0);
      const prefix = fieldString(header, 345, 155);
      const shortName = fieldString(header, 0, 100);
      const headerPath = prefix ? `${prefix}/${shortName}` : shortName;
      const headerLink = fieldString(header, 157, 100);

      if (type === "x" || type === "g" || type === "L" || type === "K") {
        if (
          headerSize > MAX_PAX_HEADER_BYTES ||
          position + roundedBlocks(headerSize) > archiveSize
        ) {
          throw new Error("update archive metadata is too large");
        }
        const data = readAt(fd, headerSize, position);
        position += roundedBlocks(headerSize);
        if (type === "x") pending = { ...pending, ...paxRecords(data) };
        if (type === "g") {
          const global = paxRecords(data);
          if (
            global.path !== undefined ||
            global.linkPath !== undefined ||
            global.size !== undefined
          ) {
            throw new Error("unsupported update archive global PAX path or size");
          }
        }
        if (type === "L") pending.path = metadataString(data, MAX_ARCHIVE_PATH_BYTES);
        if (type === "K") pending.linkPath = metadataString(data, MAX_ARCHIVE_LINK_BYTES);
        continue;
      }

      const size = pending.size ?? headerSize;
      if (size > MAX_TAR_BYTES || position + roundedBlocks(size) > archiveSize) {
        throw new Error("truncated update archive entry");
      }
      const path = pending.path ?? headerPath;
      const linkTarget = pending.linkPath ?? headerLink;
      pending = {};

      let kind: ArchiveEntryKind;
      if (type === "\0" || type === "0") kind = "file";
      else if (type === "5") kind = "directory";
      else if (type === "2") kind = "symlink";
      else if (type === "1") kind = "hardlink";
      else throw new Error(`unsupported update archive entry type: ${type.charCodeAt(0)}`);

      entries.push({
        path,
        kind,
        ...(kind === "symlink" || kind === "hardlink" ? { linkTarget } : {}),
      });
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        throw new Error("invalid update archive entry count");
      }
      position += roundedBlocks(size);
    }
    if (Object.keys(pending).length > 0) throw new Error("orphaned update archive metadata");
    return entries;
  } finally {
    closeSync(fd);
  }
}

export async function verifyArchiveLayout(archive: string, expectedRoot: string): Promise<void> {
  validateArchiveEntries(parseArchive(archive), expectedRoot);
}
