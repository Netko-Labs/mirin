import { describe, expect, test } from "bun:test";
import { parseDevtoolsConfig, resolveDevtoolsOptions } from "../src/devtools/options.ts";

describe("devtools option resolution", () => {
  test("dev runs enable everything by default", () => {
    expect(resolveDevtoolsOptions(undefined, true)).toEqual({
      enabled: true,
      inspector: true,
      file: true,
      bufferSize: 2000,
      rpcPayloads: false,
      cdp: true,
    });
  });

  test("packaged builds disable everything by default", () => {
    const options = resolveDevtoolsOptions(undefined, false);
    expect(options.enabled).toBe(false);
    expect(options.inspector).toBe(false);
    expect(options.cdp).toBe(false);
    expect(options.file).toBe(false);
  });

  // The inspector can evaluate JavaScript in a webview; individual switches must
  // not be able to turn it on in a shipped app without the explicit gate.
  test("individual switches cannot enable devtools in a packaged build", () => {
    const options = resolveDevtoolsOptions({ enabled: true, inspector: true, cdp: true }, false);
    expect(options.enabled).toBe(false);
    expect(options.inspector).toBe(false);
    expect(options.cdp).toBe(false);
  });

  test("the production gate opts a packaged build in", () => {
    const options = resolveDevtoolsOptions({ production: true }, false);
    expect(options.enabled).toBe(true);
    expect(options.inspector).toBe(true);
    expect(options.cdp).toBe(true);
  });

  test("an explicit switch still wins once permitted", () => {
    expect(resolveDevtoolsOptions({ production: true, inspector: false }, false).inspector).toBe(
      false,
    );
    expect(resolveDevtoolsOptions({ cdp: false }, true).cdp).toBe(false);
    expect(resolveDevtoolsOptions({ enabled: false }, true).enabled).toBe(false);
  });

  test("rpc payloads stay off unless asked for", () => {
    expect(resolveDevtoolsOptions(undefined, true).rpcPayloads).toBe(false);
    expect(resolveDevtoolsOptions({ rpcPayloads: true }, true).rpcPayloads).toBe(true);
  });

  test("an unusable bufferSize falls back to the default", () => {
    expect(resolveDevtoolsOptions({ bufferSize: 0 }, true).bufferSize).toBe(2000);
    expect(resolveDevtoolsOptions({ bufferSize: -5 }, true).bufferSize).toBe(2000);
    expect(resolveDevtoolsOptions({ bufferSize: 1.5 }, true).bufferSize).toBe(2000);
    expect(resolveDevtoolsOptions({ bufferSize: 50 }, true).bufferSize).toBe(50);
  });
});

describe("devtools config parsing", () => {
  test("keeps only well-typed fields", () => {
    expect(parseDevtoolsConfig({ inspector: true, bufferSize: 100 })).toEqual({
      inspector: true,
      bufferSize: 100,
    });
  });

  // A typo in mirin.config.ts must not read as "on".
  test("drops non-boolean flags rather than coercing them", () => {
    expect(parseDevtoolsConfig({ production: "true", inspector: 1 })).toEqual({});
  });

  test("drops an out-of-range bufferSize", () => {
    expect(parseDevtoolsConfig({ bufferSize: -1 })).toEqual({});
    expect(parseDevtoolsConfig({ bufferSize: "big" })).toEqual({});
  });

  test("non-objects yield no config at all", () => {
    expect(parseDevtoolsConfig(undefined)).toBeUndefined();
    expect(parseDevtoolsConfig("devtools")).toBeUndefined();
    expect(parseDevtoolsConfig([])).toBeUndefined();
  });
});
