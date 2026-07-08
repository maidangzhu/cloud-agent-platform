import { describe, expect, it } from "vitest";
import {
  fetchUrlTool,
  isBlockedIPAddress,
  isTextContentType,
  validateFetchUrl,
  type FetchUrlTransport,
} from "./fetch-url.js";

function response(
  body: BodyInit,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("fetch_url SSRF guard", () => {
  it("rejects localhost and 127.0.0.1", () => {
    expect(validateFetchUrl("http://localhost").ok).toBe(false);
    expect(validateFetchUrl("http://foo.localhost/path").ok).toBe(false);
    expect(validateFetchUrl("http://127.0.0.1").ok).toBe(false);
    expect(validateFetchUrl("http://[::1]/").ok).toBe(false);
  });

  it("rejects private CIDR ranges", () => {
    for (const url of [
      "http://10.1.2.3",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://169.254.1.1",
      "http://100.64.0.1",
      "http://[fd00::1]",
      "http://[fe80::1]",
    ]) {
      expect(validateFetchUrl(url).ok).toBe(false);
    }
  });

  it("rejects cloud metadata addresses", () => {
    expect(validateFetchUrl("http://169.254.169.254/latest").ok).toBe(false);
    expect(validateFetchUrl("http://metadata.google.internal/computeMetadata/v1").ok).toBe(false);
  });

  it("rejects non-http/https schemes", () => {
    expect(validateFetchUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateFetchUrl("ftp://example.com/file").ok).toBe(false);
  });

  it("allows public http/https URLs", () => {
    expect(validateFetchUrl("https://example.com/path").ok).toBe(true);
    expect(validateFetchUrl("http://93.184.216.34").ok).toBe(true);
  });

  it("rejects hosts that resolve to private addresses before transport runs", async () => {
    let fetched = false;
    const result = await fetchUrlTool({
      url: "https://public-name.example/path",
      resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
      transport: async () => {
        fetched = true;
        return response("should not fetch");
      },
    });

    expect(fetched).toBe(false);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toMatch(/resolved private address/);
    }
  });

  it("classifies resolved IP addresses with the same SSRF rules", () => {
    expect(isBlockedIPAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIPAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIPAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIPAddress("93.184.216.34")).toBe(false);
  });
});

describe("fetch_url content handling", () => {
  it("truncates content over size limit and marks truncated=true", async () => {
    const transport: FetchUrlTransport = async () =>
      response("<title>Hello</title>abcdef", 200, "text/html");

    const result = await fetchUrlTool({
      url: "https://example.com",
      transport,
      maxBytes: 20,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.truncated).toBe(true);
      expect(result.result.size).toBe(26);
      expect(result.result.text).toBe("<title>Hello</title>");
      expect(result.result.title).toBe("Hello");
    }
  });

  it("skips full parse for non-text content-type and records metadata only", async () => {
    const transport: FetchUrlTransport = async () =>
      response(new Uint8Array([1, 2, 3]), 200, "image/png");

    const result = await fetchUrlTool({
      url: "https://example.com/image.png",
      transport,
    });

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.contentType).toBe("image/png");
      expect(result.result.text).toBeUndefined();
      expect(result.result.title).toBeUndefined();
      expect(result.result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("recognizes text-like content types", () => {
    expect(isTextContentType("text/plain")).toBe(true);
    expect(isTextContentType("application/json")).toBe(true);
    expect(isTextContentType("application/activity+json")).toBe(true);
    expect(isTextContentType("application/pdf")).toBe(false);
  });
});

describe("fetch_url retry/status mapping", () => {
  it("succeeds on first try", async () => {
    const result = await fetchUrlTool({
      url: "https://example.com",
      transport: async () => response("ok", 200, "text/plain"),
    });

    expect(result.status).toBe("completed");
  });

  it("retries once on network failure then succeeds", async () => {
    let calls = 0;
    const result = await fetchUrlTool({
      url: "https://example.com",
      backoffMs: [0],
      sleep: async () => undefined,
      transport: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return response("ok", 200, "text/plain");
      },
    });

    expect(calls).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("exhausts retry then fails, not rejected", async () => {
    const result = await fetchUrlTool({
      url: "https://example.com",
      backoffMs: [0],
      sleep: async () => undefined,
      transport: async () => {
        throw new Error("DNS failure");
      },
    });

    expect(result).toEqual({
      status: "failed",
      error: "DNS failure",
      attempts: 2,
    });
  });

  it("maps SSRF guard to rejected, not failed", async () => {
    const result = await fetchUrlTool({
      url: "http://127.0.0.1/admin",
      transport: async () => response("should not fetch"),
    });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toMatch(/SSRF/);
    }
  });

  it("maps 4xx to rejected without retry", async () => {
    let calls = 0;
    const result = await fetchUrlTool({
      url: "https://example.com/missing",
      transport: async () => {
        calls += 1;
        return response("missing", 404, "text/plain");
      },
    });

    expect(calls).toBe(1);
    expect(result.status).toBe("rejected");
  });
});
