import { describe, expect, it } from "vitest";
import {
  fakeSearch,
  normalizeSearchResponse,
  searchWithExaProvider,
  searchWithHttpProvider,
  type SearchHttpTransport,
} from "./provider.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fake search provider", () => {
  it("returns deterministic normalized results", () => {
    const result = fakeSearch("redis streams", 2);

    expect(result).toMatchObject({
      provider: "search-fake",
      model: "fake-web-search",
      results: [
        {
          url: "https://search.example.com/redis%20streams/1",
          title: "Fake result 1 for redis streams",
          snippet: "Deterministic fake search snippet 1 for redis streams.",
        },
        {
          url: "https://search.example.com/redis%20streams/2",
          title: "Fake result 2 for redis streams",
          snippet: "Deterministic fake search snippet 2 for redis streams.",
        },
      ],
    });
  });
});

describe("search response normalization", () => {
  it("normalizes common search provider shapes", () => {
    expect(
      normalizeSearchResponse({
        web: {
          results: [
            {
              url: "https://example.com/a",
              title: "A",
              description: "Desc A",
            },
          ],
        },
      }),
    ).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "Desc A",
      },
    ]);

    expect(
      normalizeSearchResponse({
        items: [{ link: "https://example.com/b", title: "B" }],
      }),
    ).toEqual([{ url: "https://example.com/b", title: "B" }]);

    expect(
      normalizeSearchResponse({
        results: [
          {
            url: "https://example.com/exa",
            title: "Exa Result",
            highlights: ["Relevant Exa highlight"],
          },
        ],
      }),
    ).toEqual([
      {
        url: "https://example.com/exa",
        title: "Exa Result",
        snippet: "Relevant Exa highlight",
      },
    ]);
  });
});

describe("search retry behavior", () => {
  const base = {
    query: "redis streams",
    limit: 2,
    baseUrl: "https://search.test/search",
    backoffMs: [0, 0],
    sleep: async () => undefined,
  };

  it("retries on 5xx up to 2 times then succeeds", async () => {
    let calls = 0;
    const transport: SearchHttpTransport = async () => {
      calls += 1;
      if (calls < 3) return response({ error: "temporary" }, 503);
      return response({
        results: [{ url: "https://example.com", title: "Example" }],
      });
    };

    const result = await searchWithHttpProvider({ ...base, transport });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toEqual([
        { url: "https://example.com", title: "Example" },
      ]);
      expect(result.result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "retry",
        "retry",
        "success",
      ]);
    }
  });

  it("does not retry on 4xx", async () => {
    let calls = 0;
    const transport: SearchHttpTransport = async () => {
      calls += 1;
      return response({ error: "bad query" }, 429);
    };

    const result = await searchWithHttpProvider({ ...base, transport });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    if (result.ok === false) {
      expect(result.code).toBe(3001);
      expect(result.message).toMatch(/429/);
      expect(result.attempts).toHaveLength(1);
    }
  });

  it("times out a hanging provider attempt and retries", async () => {
    let calls = 0;
    const transport: SearchHttpTransport = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return response({
        results: [{ url: "https://example.com/ok", title: "OK" }],
      });
    };

    const result = await searchWithHttpProvider({
      ...base,
      transport,
      timeoutMs: 1,
      maxRetries: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "retry",
        "success",
      ]);
      expect(result.result.attempts[0].error).toMatch(/timeout/);
    }
  });
});

describe("Exa search provider", () => {
  it("uses Exa Search endpoint, API key header, and normalized result shape", async () => {
    const seen: Array<{ url: string; key?: string; body?: unknown }> = [];
    const transport: SearchHttpTransport = async (url, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        url,
        key: headers.get("x-api-key") ?? undefined,
        body: JSON.parse(String(init.body)),
      });
      return response({
        results: [
          {
            url: "https://example.com/exa",
            title: "Exa Result",
            highlights: ["From Exa highlights"],
          },
        ],
      });
    };

    const result = await searchWithExaProvider({
      query: "redis streams",
      limit: 1,
      apiKey: "exa-key",
      transport,
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.exa.ai/search");
    expect(seen[0]?.key).toBe("exa-key");
    expect(seen[0]?.body).toMatchObject({
      query: "redis streams",
      numResults: 1,
      type: "fast",
      contents: { highlights: true },
    });
    if (result.ok) {
      expect(result.result).toMatchObject({
        provider: "search-exa",
        model: "exa-search",
        results: [
          {
            url: "https://example.com/exa",
            title: "Exa Result",
            snippet: "From Exa highlights",
          },
        ],
      });
    }
  });
});
