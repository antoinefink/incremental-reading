/**
 * SSRF host classification for URL import (T060) — a pure, unit-testable guard.
 *
 * URL import fetches an arbitrary user-entered URL in the Electron MAIN process,
 * and the SAME service is reached from M13's loopback capture server — so it is a
 * network-reachable surface. Before fetching (and AGAIN after following
 * redirects, on the FINAL url), the service rejects any host that resolves to a
 * loopback / link-local / private range, so a hostile (or redirected) URL cannot
 * reach `localhost`, the cloud metadata endpoint (`169.254.169.254`), or a LAN
 * service. This module owns the pure host-classification predicate; the fetch
 * code composes it. No network, no DNS lookup here — it classifies the LITERAL
 * host (an IP literal or a hostname); a hostname that is not an obvious private
 * literal is allowed, matching the proportionate, local-first threat model.
 */

/** Strip a bracketed IPv6 host (`[::1]` → `::1`) and lowercase. */
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse a dotted-quad IPv4 literal into its 4 octets, or `null` if not one. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0] as number, octets[1] as number, octets[2] as number, octets[3] as number];
}

/** Whether an IPv4 literal falls in a loopback / link-local / RFC1918 range. */
function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes the cloud metadata endpoint).
  if (a === 169 && b === 254) return true;
  // 10.0.0.0/8 — RFC1918 private.
  if (a === 10) return true;
  // 172.16.0.0/12 — RFC1918 private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private.
  if (a === 192 && b === 168) return true;
  // 0.0.0.0/8 — "this host" (also reaches loopback on many stacks).
  if (a === 0) return true;
  return false;
}

/**
 * Whether the given host must be BLOCKED for URL import (loopback / link-local /
 * private). Classifies the literal host string:
 *  - `localhost` (and any `*.localhost`) → blocked;
 *  - IPv4 literals in `127/8`, `169.254/16`, `10/8`, `172.16/12`, `192.168/16`,
 *    `0/8` → blocked;
 *  - IPv6 loopback `::1` and link-local `fe80::/10` → blocked;
 *  - IPv4-mapped IPv6 (`::ffff:127.0.0.1`) → classified by its embedded IPv4;
 *  - anything else (a normal public hostname / IP) → allowed.
 */
export function isBlockedImportHost(rawHost: string): boolean {
  const host = normalizeHost(rawHost);
  if (host.length === 0) return true;

  // Hostname forms that always mean "this machine".
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const ipv4 = parseIPv4(host);
  if (ipv4) return isBlockedIPv4(ipv4);

  // IPv6 (no dots in the IPv4 sense; contains a colon).
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true;
    // Link-local fe80::/10 (fe80–febf).
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    // Unique-local fc00::/7 (fc/fd).
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    // IPv4-mapped / -embedded IPv6 (`::ffff:127.0.0.1`, `::127.0.0.1`).
    const tail = host.slice(host.lastIndexOf(":") + 1);
    const embedded = parseIPv4(tail);
    if (embedded) return isBlockedIPv4(embedded);
  }

  return false;
}

/** Whether a URL's scheme is an importable web scheme (`http`/`https`). */
export function isImportableScheme(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}
