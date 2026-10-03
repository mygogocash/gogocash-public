/**
 * scripts/lib/redact.ts: the RPC URL (and its parts) never reaches stdout or
 * stderr, and redacting it leaves ordinary output (JSON, addresses) intact.
 */
import { describe, expect, it } from "vitest";
import { redactRpcUrl } from "../scripts/lib/redact.ts";

const OUTPUT = '{"vault":"4CyfLznBBXqSvKhsLTXgRiqHX5NoxeAe7eaMjfKVsWNG","paused":true}';

describe("redactRpcUrl", () => {
  it("removes the URL, its host and a long user name or password", () => {
    const rpc = "https://alice:s3cretKey99@rpc.example.com/v2/abcdef?api-key=xyz123";
    const text = `fetch ${rpc} failed; getaddrinfo ENOTFOUND rpc.example.com; user alice; key s3cretKey99; path /v2/abcdef`;
    const out = redactRpcUrl(text, rpc);
    for (const part of ["rpc.example.com", "alice", "s3cretKey99", "/v2/abcdef", "api-key=xyz123"]) {
      expect(out).not.toContain(part);
    }
    expect(out).toContain("<rpc-url>");
  });

  it("a short user name or password does not corrupt the output, and is still removed with the URL", () => {
    const rpc = "https://a:xyz@rpc.example.com/";
    expect(redactRpcUrl(OUTPUT, rpc)).toBe(OUTPUT);
    expect(JSON.parse(redactRpcUrl(OUTPUT, rpc))).toEqual(JSON.parse(OUTPUT));
    const quoted = redactRpcUrl(`request to ${rpc} failed (a:xyz@rpc.example.com)`, rpc);
    expect(quoted).not.toContain("xyz");
    expect(quoted).not.toContain("rpc.example.com");
    expect(redactRpcUrl(OUTPUT, "https://ab@rpc.example.com")).toBe(OUTPUT);
  });

  it("leaves text alone when no RPC URL is configured, except for any URL", () => {
    expect(redactRpcUrl(OUTPUT, undefined)).toBe(OUTPUT);
    expect(redactRpcUrl("see https://example.org/x", "")).toBe("see <url>");
  });
});
