import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  getRegionImage: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getRegionImage: h.getRegionImage,
    },
  };
});

import { useRegionImage } from "./useRegionImage";

beforeEach(() => {
  h.desktop = true;
  h.getRegionImage.mockReset();
  h.getRegionImage.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]).buffer,
    mime: "image/png",
  });
  let n = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:region-${++n}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("useRegionImage", () => {
  it("loads region image bytes through appApi and creates an object URL", async () => {
    const { result } = renderHook(() => useRegionImage("img-1"));

    await waitFor(() => expect(result.current).toBe("blob:region-1"));
    expect(h.getRegionImage).toHaveBeenCalledWith({ elementId: "img-1" });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes the previous object URL on element change and unmount", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ id }: { id: string }) => useRegionImage(id),
      { initialProps: { id: "img-1" } },
    );
    await waitFor(() => expect(result.current).toBe("blob:region-1"));

    rerender({ id: "img-2" });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:region-1");
    await waitFor(() => expect(result.current).toBe("blob:region-2"));

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:region-2");
  });

  it("degrades to null for missing bytes or non-desktop mode", async () => {
    h.getRegionImage.mockResolvedValueOnce({ bytes: null, mime: null });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRegionImage(id), {
      initialProps: { id: "img-1" },
    });

    await waitFor(() => expect(h.getRegionImage).toHaveBeenCalledWith({ elementId: "img-1" }));
    expect(result.current).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    h.desktop = false;
    rerender({ id: "img-2" });
    expect(result.current).toBeNull();
    expect(h.getRegionImage).toHaveBeenCalledTimes(1);
  });
});
