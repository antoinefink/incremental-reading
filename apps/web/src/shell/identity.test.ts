/**
 * Local-vault identity helper tests (shell user chip).
 *
 * The shell's user chip is no longer a hardcoded persona — it derives its name +
 * avatar initials from the persisted `displayName` setting. These pure helpers
 * cover the derivation + the calm degrade when no name is set.
 */

import { describe, expect, it } from "vitest";
import {
  avatarInitials,
  DEFAULT_VAULT_NAME,
  LOCAL_VAULT_LABEL,
  resolveVaultIdentity,
} from "./identity";

describe("avatarInitials", () => {
  it("takes first+last word initials for a multi-word name", () => {
    expect(avatarInitials("Ada Lovelace")).toBe("AL");
    expect(avatarInitials("Grace Brewster Hopper")).toBe("GH");
  });

  it("takes the first two letters of a single word", () => {
    expect(avatarInitials("Ada")).toBe("AD");
    expect(avatarInitials("x")).toBe("X");
  });

  it("falls back to a neutral glyph when there are no letters", () => {
    expect(avatarInitials("")).toBe("·");
    expect(avatarInitials("   ")).toBe("·");
  });
});

describe("resolveVaultIdentity", () => {
  it("uses the set name + derived initials when present", () => {
    const id = resolveVaultIdentity("Ada Lovelace");
    expect(id.name).toBe("Ada Lovelace");
    expect(id.initials).toBe("AL");
    expect(id.sub).toBe(LOCAL_VAULT_LABEL);
    expect(id.hasName).toBe(true);
  });

  it("degrades to the neutral local-vault identity when unset", () => {
    for (const empty of ["", "   ", null, undefined]) {
      const id = resolveVaultIdentity(empty);
      expect(id.name).toBe(DEFAULT_VAULT_NAME);
      expect(id.initials).toBe("·");
      expect(id.hasName).toBe(false);
    }
  });

  it("trims a name before deriving", () => {
    const id = resolveVaultIdentity("  Ada Lovelace  ");
    expect(id.name).toBe("Ada Lovelace");
    expect(id.initials).toBe("AL");
  });
});
