#!/usr/bin/env bun

import { resolve } from "node:path";

const input = Bun.argv[2];
if (!input) throw new Error("usage: bun scripts/write-sha256.ts <file>");

const path = resolve(input);
const hasher = new Bun.CryptoHasher("sha256");
for await (const chunk of Bun.file(path).stream()) {
  hasher.update(chunk);
}

const checksumPath = `${path}.sha256`;
await Bun.write(checksumPath, `${hasher.digest("hex")}\n`);
console.log(checksumPath);
