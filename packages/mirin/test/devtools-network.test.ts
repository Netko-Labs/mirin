import { describe, expect, test } from "bun:test";
import {
  headersMs,
  isSensitiveName,
  redactHeaders,
  redactUrl,
  statusLevel,
} from "../src/devtools/lib/network.ts";

describe("sensitive name detection", () => {
  test("catches credential headers and the names apps invent for them", () => {
    for (const name of [
      "Authorization",
      "cookie",
      "Set-Cookie",
      "Proxy-Authorization",
      "x-api-key",
      "X-Api-Key",
      "api_key",
      "x-auth-token",
      "X-Session-Id",
      "refresh_token",
      "client-secret",
      "password",
    ]) {
      expect(isSensitiveName(name)).toBe(true);
    }
  });

  test("leaves ordinary headers readable", () => {
    for (const name of [
      "content-type",
      "content-length",
      "accept",
      "user-agent",
      "cache-control",
      "x-request-id",
      "keep-alive",
      "referer",
    ]) {
      expect(isSensitiveName(name)).toBe(false);
    }
  });
});

describe("header redaction", () => {
  // The whole point: the stream is durable plaintext on disk.
  test("hides values but keeps the names", () => {
    const out = redactHeaders({
      authorization: "Bearer sk-live-abcdef123456",
      cookie: "session=deadbeef",
      "content-type": "application/json",
    });

    expect(out).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
      "content-type": "application/json",
    });
    // Knowing the header was sent is the diagnostic value; its content is not.
    expect(JSON.stringify(out)).not.toContain("sk-live");
    expect(JSON.stringify(out)).not.toContain("deadbeef");
  });

  test("truncates a huge value instead of dropping it", () => {
    const out = redactHeaders({ "x-trace": "a".repeat(5000) });
    expect(out["x-trace"]?.length).toBeLessThan(300);
    expect(out["x-trace"]).toContain("(truncated)");
  });

  test("caps how many headers one request can contribute", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`x-h${i}`] = String(i);
    const out = redactHeaders(many);

    expect(Object.keys(out).length).toBeLessThanOrEqual(33);
    expect(out["…"]).toContain("more");
  });

  test("a non-object header bag is empty, not a crash", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders("nope")).toEqual({});
  });
});

describe("url redaction", () => {
  // A token in a query string is just as durable as one in a header.
  test("hides credential-bearing query parameters", () => {
    // The query and the fragment use the same marker: both go through one lexical
    // pass, so a reader sees `[redacted]` wherever a credential was hidden.
    expect(redactUrl("https://api.example.com/v1/me?api_key=secret123&page=2")).toBe(
      "https://api.example.com/v1/me?api_key=[redacted]&page=2",
    );
    expect(redactUrl("https://x.test/cb?access_token=abc")).toContain("redacted");
    expect(redactUrl("https://x.test/cb?access_token=abc")).not.toContain("abc");
  });

  // A credential in the authority is not in the query string, so a redactor that
  // only walks searchParams writes it to disk verbatim.
  test("hides basic-auth userinfo, with or without a query string", () => {
    expect(redactUrl("https://svc:s3cr3t@api.example.com/v1/me?page=2")).not.toContain("s3cr3t");
    expect(redactUrl("https://svc:s3cr3t@api.example.com/v1/me")).not.toContain("s3cr3t");
    // No `?` at all must still be examined.
    expect(redactUrl("https://svc:s3cr3t@api.example.com/")).not.toContain("s3cr3t");
    expect(redactUrl("https://svc:s3cr3t@api.example.com/v1/me")).toContain("api.example.com");
  });

  test("hides userinfo in a URL that will not parse", () => {
    const out = redactUrl("weird+scheme://user:hunter2@host/path");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("host/path");
  });

  // OAuth's implicit flow returns the token in the fragment, and a fragment never
  // reaches the network — `navigation` is the only event that ever sees it.
  test("hides credentials in the fragment, not just the query", () => {
    expect(
      redactUrl("https://app.test/callback#access_token=ya29.LIVE&token_type=Bearer"),
    ).not.toContain("ya29.LIVE");
    expect(redactUrl("myapp://cb#id_token=eyJhbGciLEAK")).not.toContain("eyJhbGciLEAK");
    // The sharpest case: the same secret name, redacted in one half and not the other.
    const both = redactUrl("https://api.test/x?api_key=k#session=SECRETFRAG");
    expect(both).not.toContain("SECRETFRAG");
    expect(both).not.toContain("?api_key=k");
  });

  test("hides a fragment credential in a URL that will not parse", () => {
    const out = redactUrl("weird+scheme://host/path?token=t#access_token=frag");
    expect(out).not.toContain("#access_token=frag");
    expect(out).toContain("host/path");
  });

  test("leaves an ordinary fragment alone", () => {
    const url = "https://app.test/page#section-two";
    expect(redactUrl(url)).toBe(url);
  });

  test("leaves an ordinary URL untouched", () => {
    const url = "http://127.0.0.1:5173/ui/main.tsx?t=1699999";
    expect(redactUrl(url)).toBe(url);
  });

  test("still redacts when the URL will not parse", () => {
    const out = redactUrl("//broken url/path?token=abc&page=1");
    expect(out).toContain("token=[redacted]");
    expect(out).not.toContain("abc");
    expect(out).toContain("page=1");
  });

  // The three ways a pair could hide from the splitter itself. These are not limits
  // of the name heuristic — the names here are exactly what it is built to catch; it
  // simply never got to see them.
  test("sees through a percent-encoded separator", () => {
    // `#access_token%3Dya29.LIVE` is one opaque token until it is decoded.
    expect(redactUrl("https://app.test/cb#access_token%3Dya29.LIVE")).not.toContain("ya29.LIVE");
    expect(redactUrl("https://api.test/x?api_key%3Dsecret123")).not.toContain("secret123");
    // The name keeps its original spelling so the reader still knows what was hidden.
    expect(redactUrl("https://app.test/cb#access_token%3Dya29.LIVE")).toContain("access_token");
  });

  // Regression: `searchParams` decoded `api_key%3Dsecret` into a single *name*, matched
  // it, then appended `=[redacted]` — leaving the secret in the name and producing
  // output that read as redacted while carrying the credential.
  test("does not append a marker while leaving the secret in the name", () => {
    const out = redactUrl("https://api.test/x?api_key%3Dsecret123");
    expect(out).not.toContain("secret123");
    expect(out).not.toMatch(/secret123.*redacted/);
  });

  test("splits on a legacy semicolon separator as well as an ampersand", () => {
    expect(redactUrl("https://api.test/x?page=2;api_key=semisecret")).not.toContain("semisecret");
    expect(redactUrl("https://app.test/cb#state=a;access_token=fragsecret")).not.toContain(
      "fragsecret",
    );
    // Mixed separators, and each is preserved where it was.
    expect(redactUrl("https://api.test/x?a=1&token=mixed;b=2")).toBe(
      "https://api.test/x?a=1&token=[redacted];b=2",
    );
  });

  test("leaves a semicolon in an ordinary value alone", () => {
    const url = "https://api.test/x?filter=a;b";
    expect(redactUrl(url)).toBe(url);
  });

  test("caps a data: URL rather than storing the payload", () => {
    const out = redactUrl(`data:image/png;base64,${"A".repeat(4000)}`);
    expect(out.length).toBeLessThan(600);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("response severity", () => {
  // `mirin check` fails a run on any error-level event, so this table decides
  // which HTTP statuses can fail a check.
  test("only a 5xx is an error", () => {
    expect(statusLevel(200)).toBe("debug");
    expect(statusLevel(304)).toBe("debug");
    expect(statusLevel(404)).toBe("warn");
    expect(statusLevel(429)).toBe("warn");
    expect(statusLevel(500)).toBe("error");
    expect(statusLevel(503)).toBe("error");
  });
});

describe("timing", () => {
  test("reports time to response headers when CDP measured it", () => {
    expect(headersMs({ receiveHeadersEnd: 38.7 })).toBe(39);
    expect(headersMs({ receiveHeadersEnd: -1 })).toBeUndefined();
    expect(headersMs(undefined)).toBeUndefined();
  });
});
