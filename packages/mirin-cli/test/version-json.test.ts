import { describe, expect, test } from "bun:test";
import { parseVersionJson } from "../../mirin/src/updater/lib/version.ts";
import {
  parseVersionMetadata,
  serializeVersionMetadata,
  validateVersionMetadataForBundle,
} from "../src/shared/validation/version-json.ts";

const publicKey = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const identity = {
  appName: "Safe App",
  bundleId: "dev.example.safe-app",
  channel: "stable",
  version: "1.2.3-beta.1",
};

describe("CLI version.json", () => {
  test("serializes six validated fields accepted by the runtime parser", () => {
    const serialized = serializeVersionMetadata({
      ...identity,
      baseUrl: "https://example.com/releases/latest/download",
      publicKey,
    });
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "version",
      "channel",
      "baseUrl",
      "publicKey",
      "name",
      "identifier",
    ]);
    expect(parseVersionMetadata(serialized)).toEqual({
      version: identity.version,
      channel: identity.channel,
      baseUrl: "https://example.com/releases/latest/download",
      publicKey,
      name: identity.appName,
      identifier: identity.bundleId,
    });
    expect(parseVersionJson(serialized)).toEqual({
      version: identity.version,
      channel: identity.channel,
      baseUrl: "https://example.com/releases/latest/download",
      publicKey,
      name: identity.appName,
      identifier: identity.bundleId,
    });
  });

  test("rejects malformed, extra-field, unsafe URL, and mismatched metadata", () => {
    expect(() => parseVersionMetadata("not json")).toThrow("expected JSON");
    expect(() =>
      parseVersionMetadata(
        JSON.stringify({
          version: "1.2.3",
          channel: "stable",
          baseUrl: "https://example.com",
          publicKey,
          name: "Safe App",
          identifier: "dev.example.safe-app",
          extra: true,
        }),
      ),
    ).toThrow("exactly six");
    expect(() =>
      serializeVersionMetadata({ ...identity, baseUrl: "http://example.com", publicKey }),
    ).toThrow("must use HTTPS");
    expect(() =>
      serializeVersionMetadata({
        ...identity,
        baseUrl: "https://example.com",
        publicKey: "not-base64",
      }),
    ).toThrow("update public key");

    const mismatched = serializeVersionMetadata({
      ...identity,
      version: "2.0.0",
      baseUrl: "http://localhost:4000",
      publicKey,
    });
    expect(() => validateVersionMetadataForBundle(mismatched, identity)).toThrow("does not match");
  });
});
