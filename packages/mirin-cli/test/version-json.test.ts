import { describe, expect, test } from "bun:test";
import {
  parseVersionMetadata,
  serializeVersionMetadata,
  validateVersionMetadataForBundle,
} from "../src/shared/validation/version-json.ts";

const identity = {
  appName: "Safe App",
  bundleId: "dev.example.safe-app",
  channel: "stable",
  version: "1.2.3-beta.1",
};

describe("CLI version.json", () => {
  test("serializes and reads back exactly the five validated fields", () => {
    const serialized = serializeVersionMetadata({
      ...identity,
      baseUrl: "https://example.com/releases/latest/download",
    });
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "version",
      "channel",
      "baseUrl",
      "name",
      "identifier",
    ]);
    expect(parseVersionMetadata(serialized)).toEqual({
      version: identity.version,
      channel: identity.channel,
      baseUrl: "https://example.com/releases/latest/download",
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
          name: "Safe App",
          identifier: "dev.example.safe-app",
          extra: true,
        }),
      ),
    ).toThrow("exactly five");
    expect(() => serializeVersionMetadata({ ...identity, baseUrl: "http://example.com" })).toThrow(
      "must use HTTPS",
    );

    const mismatched = serializeVersionMetadata({
      ...identity,
      version: "2.0.0",
      baseUrl: "http://localhost:4000",
    });
    expect(() => validateVersionMetadataForBundle(mismatched, identity)).toThrow("does not match");
  });
});
