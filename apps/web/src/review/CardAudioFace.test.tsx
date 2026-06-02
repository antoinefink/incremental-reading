/**
 * CardAudioFace component tests (T075).
 *
 * The audio-card review face:
 *  - a LOCAL source mounts a looping `<audio>` whose `src` is the privileged
 *    `media://<sourceElementId>` URL (the renderer never resolves a vault path);
 *  - a YOUTUBE source mounts an IFrame Player bounded to the clip window;
 *  - the boundary is driven by a tight rAF re-seek (asserted via the seek-to-start on
 *    `loadedmetadata`), not the coarse `timeupdate` alone.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
}));

import { CardAudioFace } from "./CardAudioFace";

const REF = { sourceElementId: "src_1", startMs: 42_000, endMs: 75_000, on: "prompt" as const };

describe("CardAudioFace — local source", () => {
  it("renders a looping <audio> with the media:// URL", () => {
    render(<CardAudioFace mediaRef={REF} mediaSource="local" youtubeId={null} face="prompt" />);
    const audio = screen.getByTestId("card-audio-prompt-el") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("media://src_1");
    // Non-looping at the element level — the precise rAF re-seek owns the boundary.
    expect(audio.loop).toBe(false);
    expect(screen.getByText(/Loop 0:42–1:15/)).toBeTruthy();
  });

  it("seeks the element to the clip start on loadedmetadata (the loop window)", () => {
    render(<CardAudioFace mediaRef={REF} mediaSource="local" youtubeId={null} face="answer" />);
    const audio = screen.getByTestId("card-audio-answer-el") as HTMLAudioElement;
    // jsdom has no media clock; fire loadedmetadata and assert the seek to startMs.
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(audio.currentTime).toBe(42); // 42_000 ms → 42 s
  });
});

describe("CardAudioFace — youtube source", () => {
  it("renders a bounded IFrame Player for the clip window", () => {
    render(<CardAudioFace mediaRef={REF} mediaSource="youtube" youtubeId="abc123" face="prompt" />);
    const wrap = screen.getByTestId("card-audio-prompt-youtube");
    const iframe = wrap.querySelector("iframe");
    expect(iframe).toBeTruthy();
    const src = iframe?.getAttribute("src") ?? "";
    expect(src).toContain("youtube.com/embed/abc123");
    // The clip window bounds the embed (whole seconds): start 42, end 75.
    expect(src).toContain("start=42");
    expect(src).toContain("end=75");
    expect(src).toContain("enablejsapi=1");
  });

  it("degrades to a plain caption when the youtube id is missing", () => {
    render(<CardAudioFace mediaRef={REF} mediaSource="youtube" youtubeId={null} face="prompt" />);
    const el = screen.getByTestId("card-audio-prompt-youtube");
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.textContent).toMatch(/0:42–1:15/);
  });
});
