import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProtocolHandler = (request: Request) => Response | Promise<Response>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, ProtocolHandler>(),
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn((scheme: string, handler: ProtocolHandler) => {
    electronMock.handlers.set(scheme, handler);
  }),
}));

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: electronMock.registerSchemesAsPrivileged,
    handle: electronMock.handle,
  },
}));

import {
  MEDIA_SCHEME,
  registerMediaProtocol,
  registerMediaSchemePrivileges,
} from "./media-protocol";

let assetsDir: string;

beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-media-protocol-"));
  electronMock.handlers.clear();
  electronMock.registerSchemesAsPrivileged.mockClear();
  electronMock.handle.mockClear();
});

afterEach(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

function writeAsset(snapshotKey: string, content: string): void {
  const abs = path.join(assetsDir, ...snapshotKey.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function dbServiceFor(source: { snapshotKey: string | null; mediaKind: string | null } | null) {
  return {
    repos: {
      sources: {
        findById: vi.fn(() => (source ? { source } : null)),
      },
    },
  };
}

function handler(): ProtocolHandler {
  const registered = electronMock.handlers.get(MEDIA_SCHEME);
  if (!registered) throw new Error("media protocol handler was not registered");
  return registered;
}

async function readText(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

describe("media protocol", () => {
  it("registers the media scheme as secure and stream-capable", () => {
    registerMediaSchemePrivileges();

    expect(electronMock.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: MEDIA_SCHEME,
        privileges: {
          secure: true,
          stream: true,
          supportFetchAPI: true,
          bypassCSP: false,
        },
      },
    ]);
  });

  it("streams a local media asset with byte-range support", async () => {
    const snapshotKey = "sources/source-1/original.mp4";
    writeAsset(snapshotKey, "0123456789");
    registerMediaProtocol(dbServiceFor({ snapshotKey, mediaKind: "video" }) as never, assetsDir);

    const full = await handler()(new Request("media://source-1"));
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Content-Length")).toBe("10");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await readText(full)).toBe("0123456789");

    const ranged = await handler()(
      new Request("media://source-1", { headers: { Range: "bytes=2-5" } }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("Content-Length")).toBe("4");
    expect(await readText(ranged)).toBe("2345");
  });

  it("supports suffix ranges and clamps open-ended ranges to the file size", async () => {
    const snapshotKey = "sources/source-1/original.mp3";
    writeAsset(snapshotKey, "0123456789");
    registerMediaProtocol(dbServiceFor({ snapshotKey, mediaKind: "audio" }) as never, assetsDir);

    const suffix = await handler()(
      new Request("media://source-1", { headers: { Range: "bytes=-3" } }),
    );
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(suffix.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await readText(suffix)).toBe("789");

    const openEnded = await handler()(
      new Request("media://source-1", { headers: { Range: "bytes=8-" } }),
    );
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("Content-Range")).toBe("bytes 8-9/10");
    expect(await readText(openEnded)).toBe("89");
  });

  it("rejects missing ids, non-local media, missing files, and unknown sources", async () => {
    registerMediaProtocol(dbServiceFor(null) as never, assetsDir);
    expect(await handler()({ url: "media:///", headers: new Headers() } as Request)).toHaveProperty(
      "status",
      400,
    );
    expect(await handler()(new Request("media://unknown"))).toHaveProperty("status", 404);

    electronMock.handlers.clear();
    registerMediaProtocol(
      dbServiceFor({ snapshotKey: "sources/youtube/original.mp4", mediaKind: "youtube" }) as never,
      assetsDir,
    );
    expect(await handler()(new Request("media://youtube"))).toHaveProperty("status", 404);

    electronMock.handlers.clear();
    registerMediaProtocol(
      dbServiceFor({ snapshotKey: "sources/missing/original.mp4", mediaKind: "video" }) as never,
      assetsDir,
    );
    expect(await handler()(new Request("media://missing"))).toHaveProperty("status", 404);
  });
});
