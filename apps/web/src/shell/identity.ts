/**
 * Local-vault identity helpers (shell user chip).
 *
 * The desktop app has no server account — the "user" is simply the owner of the
 * local vault. The display name is a persisted setting (`displayName`, see
 * `@interleave/core` `AppSettings`); these pure helpers derive the chip's visible
 * name, its sub-label, and the avatar initials from it.
 *
 * When the name is empty (a brand-new vault, or the renderer is running outside
 * the desktop shell where there is no SQLite) the identity degrades to a calm,
 * non-fictional placeholder — never an invented persona.
 */

/** Sub-label shown under the name in the user chip. */
export const LOCAL_VAULT_LABEL = "Local vault";

/** The name shown when no `displayName` has been set yet. */
export const DEFAULT_VAULT_NAME = LOCAL_VAULT_LABEL;

/** Fallback avatar glyph when there are no usable initials. */
const DEFAULT_AVATAR = "·";

/** The resolved identity the user chip renders. */
export interface VaultIdentity {
  /** The chip's primary line — the set name, or the neutral vault label. */
  readonly name: string;
  /** The chip's secondary line — always the local-vault label. */
  readonly sub: string;
  /** 1–2 uppercase avatar initials derived from the name, or a neutral glyph. */
  readonly initials: string;
  /** Whether the user has actually set a name (vs the neutral placeholder). */
  readonly hasName: boolean;
}

/**
 * Derive up to two uppercase initials from a display name: the first letter of
 * the first and last whitespace-separated words (or the first two letters of a
 * single word). Returns a neutral glyph when no letters are present.
 */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return DEFAULT_AVATAR;
  if (words.length === 1) {
    const w = words[0] ?? "";
    return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase() || DEFAULT_AVATAR;
  }
  const first = words[0]?.[0] ?? "";
  const last = words[words.length - 1]?.[0] ?? "";
  const initials = (first + last).toUpperCase();
  return initials || DEFAULT_AVATAR;
}

/**
 * Resolve the user-chip identity from the (possibly empty) persisted display
 * name. Whitespace-only names are treated as unset, so the chip never shows an
 * empty or fictional identity.
 */
export function resolveVaultIdentity(displayName: string | null | undefined): VaultIdentity {
  const trimmed = (displayName ?? "").trim();
  const hasName = trimmed.length > 0;
  return {
    name: hasName ? trimmed : DEFAULT_VAULT_NAME,
    sub: LOCAL_VAULT_LABEL,
    initials: hasName ? avatarInitials(trimmed) : DEFAULT_AVATAR,
    hasName,
  };
}
