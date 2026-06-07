import { describe, expect, it, vi } from "vitest";
import {
  assertImportableUrl,
  fetchImportablePage,
  MAX_BODY_BYTES,
  UrlFetchError,
  type UrlFetchErrorCode,
} from "./url-fetch";

function expectCode(err: unknown, code: UrlFetchErrorCode) {
  expect(err).toBeInstanceOf(UrlFetchError);
  expect((err as UrlFetchError).code).toBe(code);
}

async function expectRejectsCode(promise: Promise<unknown>, code: UrlFetchErrorCode) {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (err) {
    expectCode(err, code);
  }
}

describe("assertImportableUrl", () => {
  it("allows public http(s) URLs", () => {
    expect(assertImportableUrl("https://example.com/article", false).href).toBe(
      "https://example.com/article",
    );
  });

  it("rejects unsupported schemes and private hosts by default", () => {
    expect(() => assertImportableUrl("ftp://example.com/file", false)).toThrow(UrlFetchError);
    expect(() => assertImportableUrl("http://127.0.0.1:3000/article", false)).toThrow(
      UrlFetchError,
    );
  });

  it("can allow loopback only when explicitly requested", () => {
    expect(assertImportableUrl("http://127.0.0.1:3000/article", true).hostname).toBe("127.0.0.1");
  });
});

describe("fetchImportablePage", () => {
  it("fetches HTML with the import headers and returns the final URL", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response("<html><title>Article</title></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const result = await fetchImportablePage("https://example.com/article", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      html: "<html><title>Article</title></html>",
      finalUrl: "https://example.com/article",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toMatchObject({
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": expect.stringContaining("Interleave"),
    });
  });

  it("follows safe redirects manually and returns the last URL", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://example.com/redirect") {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/final" },
        });
      }
      return new Response("<html>final</html>", {
        headers: { "content-type": "text/html" },
      });
    });

    await expect(
      fetchImportablePage("https://example.com/redirect", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ html: "<html>final</html>", finalUrl: "https://example.com/final" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("permits an absent content-type so article extraction can decide later", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new TextEncoder().encode("<html>No content type</html>")),
    );

    await expect(
      fetchImportablePage("https://example.com/no-header", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      html: "<html>No content type</html>",
      finalUrl: "https://example.com/no-header",
    });
  });

  it("rejects non-HTML responses before reading the body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );

    await expectRejectsCode(
      fetchImportablePage("https://example.com/data", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      "not_html",
    );
  });

  it("rejects oversized declared content-lengths", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html></html>", {
          headers: {
            "content-type": "text/html",
            "content-length": String(MAX_BODY_BYTES + 1),
          },
        }),
    );

    await expectRejectsCode(
      fetchImportablePage("https://example.com/huge", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      "too_large",
    );
  });

  it("rejects streamed bodies that exceed the cap even without content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/html" },
        }),
    );

    await expectRejectsCode(
      fetchImportablePage("https://example.com/stream", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      "too_large",
    );
  });

  it("checks redirect targets before issuing the next request", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        }),
    );

    await expectRejectsCode(
      fetchImportablePage("https://example.com/redirect", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      "blocked_host",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps aborts and network failures to stable error codes", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const timeoutFetch = vi.fn(async () => {
      throw abort;
    });
    const failedFetch = vi.fn(async () => {
      throw new Error("offline");
    });

    await expectRejectsCode(
      fetchImportablePage("https://example.com/slow", {
        fetchImpl: timeoutFetch as unknown as typeof fetch,
      }),
      "timeout",
    );
    await expectRejectsCode(
      fetchImportablePage("https://example.com/offline", {
        fetchImpl: failedFetch as unknown as typeof fetch,
      }),
      "fetch_failed",
    );
  });

  it("maps non-2xx responses to http_error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("missing", { status: 404, headers: { "content-type": "text/html" } }),
    );

    await expectRejectsCode(
      fetchImportablePage("https://example.com/missing", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      "http_error",
    );
  });
});
