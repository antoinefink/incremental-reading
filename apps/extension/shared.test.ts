import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAPTURE_PORT,
  extensionOrigin,
  loopbackBase,
  pairWithApp,
  pingApp,
  type RecentCapture,
  readPairedConfig,
  recordRecentCapture,
  STORAGE_KEYS,
  sendCapture,
  writePairedConfig,
} from "./src/shared";

let storage: Record<string, unknown>;

function installChromeMock() {
  storage = {};
  const local = {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      }
      if (typeof keys === "string") {
        return { [keys]: storage[keys] };
      }
      if (keys && typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            storage[key] === undefined ? fallback : storage[key],
          ]),
        );
      }
      return { ...storage };
    }),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(storage, values);
    }),
  };

  vi.stubGlobal("chrome", {
    runtime: { id: "abcdefghijklmnopabcdefghijklmnop" },
    storage: { local },
  });
  return local;
}

function installFetch(response: Response | (() => Response | Promise<Response>)) {
  const fetchMock = vi.fn(async () => (typeof response === "function" ? response() : response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extension shared helpers", () => {
  it("builds the extension origin and loopback base URL", () => {
    expect(extensionOrigin()).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(loopbackBase(47616)).toBe("http://127.0.0.1:47616");
  });

  it("reads defaults and persists paired config", async () => {
    expect(await readPairedConfig()).toEqual({ token: null, port: DEFAULT_CAPTURE_PORT });

    await writePairedConfig("token-1", 47617);

    expect(storage[STORAGE_KEYS.token]).toBe("token-1");
    expect(storage[STORAGE_KEYS.port]).toBe(47617);
    expect(await readPairedConfig()).toEqual({ token: "token-1", port: 47617 });
  });

  it("pings only a healthy Interleave loopback response", async () => {
    const fetchMock = installFetch(
      new Response(JSON.stringify({ ok: true, app: "interleave", version: "0.1.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(pingApp(47615)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:47615/ping", { method: "GET" });

    installFetch(new Response(JSON.stringify({ ok: true, app: "other" }), { status: 200 }));
    await expect(pingApp(47615)).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(pingApp(47615)).resolves.toBe(false);
  });

  it("pairs by posting the extension origin with a bearer token", async () => {
    const fetchMock = installFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(pairWithApp("pair-token", 47616)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:47616/pair");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer pair-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      extensionOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    });
  });

  it("normalizes capture outcomes for missing pairing, invalid input, auth, and offline failures", async () => {
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "not-paired",
    });

    storage[STORAGE_KEYS.token] = "token-1";
    storage[STORAGE_KEYS.port] = 47618;
    const fetchMock = installFetch(new Response("bad token", { status: 401 }));
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "bad-token",
    });

    installFetch(new Response("unpaired", { status: 403 }));
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "not-paired",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "not-running",
    });

    await expect(sendCapture({ kind: "page", url: "ftp://example.com/a" })).resolves.toMatchObject({
      kind: "error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts a shaped capture and returns the successful server response", async () => {
    storage[STORAGE_KEYS.token] = "token-1";
    storage[STORAGE_KEYS.port] = 47619;
    const body = { ok: true, id: "src-1", kind: "page", title: "Article", deduped: false };
    const fetchMock = installFetch(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      sendCapture({ kind: "page", url: " https://example.com/a ", title: " Article " }),
    ).resolves.toEqual({ kind: "ok", response: body });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:47619/capture");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      kind: "page",
      url: "https://example.com/a",
      title: "Article",
      priority: "C",
    });
  });

  it("surfaces malformed and explicit server errors", async () => {
    storage[STORAGE_KEYS.token] = "token-1";

    installFetch(new Response("not json", { status: 500 }));
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "error",
      message: "Unexpected response (500)",
    });

    installFetch(
      new Response(JSON.stringify({ ok: false, error: "import_failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(sendCapture({ kind: "page", url: "https://example.com/a" })).resolves.toEqual({
      kind: "error",
      message: "import_failed",
    });
  });

  it("keeps recent captures newest-first and capped at twenty", async () => {
    const existing: RecentCapture[] = Array.from({ length: 25 }, (_, index) => ({
      id: `old-${index}`,
      title: `Old ${index}`,
      kind: "page",
      timestamp: index,
    }));
    storage[STORAGE_KEYS.recentCaptures] = existing;

    await recordRecentCapture({
      id: "new",
      title: "New capture",
      kind: "selection",
      timestamp: 100,
    });

    const next = storage[STORAGE_KEYS.recentCaptures] as RecentCapture[];
    expect(next).toHaveLength(20);
    expect(next[0]).toMatchObject({ id: "new", title: "New capture", kind: "selection" });
    expect(next.at(-1)?.id).toBe("old-18");
  });
});
