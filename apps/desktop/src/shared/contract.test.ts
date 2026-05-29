/**
 * IPC contract validation tests (T007).
 *
 * The security posture depends on the main side rejecting malformed renderer
 * payloads, so these assert the Zod schemas accept valid requests and reject
 * invalid ones, and that the channel set is exactly the four M1 commands (no
 * generic `db.query`).
 */

import { describe, expect, it } from "vitest";
import {
  IPC_CHANNELS,
  SettingKeySchema,
  SettingsGetRequestSchema,
  SettingsUpdateRequestSchema,
} from "./contract";

describe("IPC channels", () => {
  it("exposes exactly the four M1 commands and no generic SQL channel", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual(
      ["app:health", "db:getStatus", "settings:get", "settings:update"].sort(),
    );
    expect(Object.values(IPC_CHANNELS)).not.toContain("db:query");
  });
});

describe("SettingsGetRequestSchema", () => {
  it("accepts an empty object (all settings)", () => {
    expect(SettingsGetRequestSchema.parse({})).toEqual({});
  });

  it("accepts a key", () => {
    expect(SettingsGetRequestSchema.parse({ key: "theme" })).toEqual({ key: "theme" });
  });

  it("rejects an empty key", () => {
    expect(() => SettingsGetRequestSchema.parse({ key: "" })).toThrow();
  });
});

describe("SettingsUpdateRequestSchema", () => {
  it("accepts a key + arbitrary JSON value", () => {
    const parsed = SettingsUpdateRequestSchema.parse({ key: "budget", value: 20 });
    expect(parsed.key).toBe("budget");
    expect(parsed.value).toBe(20);
  });

  it("requires a key", () => {
    expect(() => SettingsUpdateRequestSchema.parse({ value: 1 })).toThrow();
  });

  it("rejects an over-long key", () => {
    expect(() => SettingKeySchema.parse("x".repeat(200))).toThrow();
  });
});
