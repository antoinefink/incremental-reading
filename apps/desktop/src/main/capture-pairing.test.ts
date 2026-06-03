import type { SettingsRepository } from "@interleave/local-db";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_ALLOWED_ORIGIN_KEY,
  CAPTURE_ENABLED_KEY,
  CAPTURE_PORT_KEY,
  CAPTURE_TOKEN_KEY,
  clearCapturePort,
  getAllowedOrigin,
  getCaptureEnabled,
  getCapturePort,
  getOrCreateCaptureToken,
  regenerateCaptureToken,
  setAllowedOrigin,
  setCaptureEnabled,
  setCapturePort,
} from "./capture-pairing";

class MemorySettings {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | null {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  getOr<T>(key: string, fallback: T): T {
    const value = this.get<T>(key);
    return value === null ? fallback : value;
  }

  set<T>(key: string, value: T): T {
    this.values.set(key, value);
    return value;
  }

  asRepository(): SettingsRepository {
    return this as unknown as SettingsRepository;
  }
}

describe("capture pairing settings", () => {
  it("defaults capture to disabled and persists toggles", () => {
    const settings = new MemorySettings();

    expect(getCaptureEnabled(settings.asRepository())).toBe(false);

    setCaptureEnabled(settings.asRepository(), true);
    expect(settings.values.get(CAPTURE_ENABLED_KEY)).toBe(true);
    expect(getCaptureEnabled(settings.asRepository())).toBe(true);

    setCaptureEnabled(settings.asRepository(), false);
    expect(getCaptureEnabled(settings.asRepository())).toBe(false);
  });

  it("mints the pairing token lazily and reuses it", () => {
    const settings = new MemorySettings();

    expect(settings.values.has(CAPTURE_TOKEN_KEY)).toBe(false);
    const token = getOrCreateCaptureToken(settings.asRepository());

    expect(token).toHaveLength(43);
    expect(settings.values.get(CAPTURE_TOKEN_KEY)).toBe(token);
    expect(getOrCreateCaptureToken(settings.asRepository())).toBe(token);
  });

  it("ignores empty stored tokens and replaces them with a fresh token", () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "");

    const token = getOrCreateCaptureToken(settings.asRepository());

    expect(token).toHaveLength(43);
    expect(settings.values.get(CAPTURE_TOKEN_KEY)).toBe(token);
  });

  it("regenerates the token without clearing the paired origin", () => {
    const settings = new MemorySettings();
    const original = getOrCreateCaptureToken(settings.asRepository());
    setAllowedOrigin(
      settings.asRepository(),
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );

    const next = regenerateCaptureToken(settings.asRepository());

    expect(next).toHaveLength(43);
    expect(next).not.toBe(original);
    expect(settings.values.get(CAPTURE_TOKEN_KEY)).toBe(next);
    expect(getAllowedOrigin(settings.asRepository())).toBe(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );
  });

  it("stores and clears the bound capture port", () => {
    const settings = new MemorySettings();

    expect(getCapturePort(settings.asRepository())).toBeNull();

    setCapturePort(settings.asRepository(), 47616);
    expect(settings.values.get(CAPTURE_PORT_KEY)).toBe(47616);
    expect(getCapturePort(settings.asRepository())).toBe(47616);

    clearCapturePort(settings.asRepository());
    expect(settings.values.get(CAPTURE_PORT_KEY)).toBeNull();
    expect(getCapturePort(settings.asRepository())).toBeNull();
  });

  it("returns null for unset or empty paired origins", () => {
    const settings = new MemorySettings();

    expect(getAllowedOrigin(settings.asRepository())).toBeNull();

    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, "");
    expect(getAllowedOrigin(settings.asRepository())).toBeNull();

    setAllowedOrigin(
      settings.asRepository(),
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );
    expect(getAllowedOrigin(settings.asRepository())).toBe(
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    );
  });
});
