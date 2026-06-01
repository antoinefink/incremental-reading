/**
 * SSRF host-guard tests (T060).
 *
 * The URL-import fetch is a network-reachable surface (also reached from M13's
 * loopback capture server), so the loopback / link-local / private-range guard is
 * a REQUIRED, unit-tested behavior, not optional prose. These pin each blocked
 * range and confirm public hosts are allowed.
 */

import { describe, expect, it } from "vitest";
import { isBlockedImportHost, isImportableScheme } from "./url-import-host";

describe("isBlockedImportHost", () => {
  it("blocks loopback (127.0.0.0/8 + localhost + ::1)", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "api.localhost", "::1", "[::1]"]) {
      expect(isBlockedImportHost(host)).toBe(true);
    }
  });

  it("blocks link-local 169.254.0.0/16 (incl. the cloud metadata endpoint)", () => {
    expect(isBlockedImportHost("169.254.169.254")).toBe(true);
    expect(isBlockedImportHost("169.254.0.1")).toBe(true);
  });

  it("blocks RFC1918 private ranges (10/8, 172.16/12, 192.168/16)", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
    ]) {
      expect(isBlockedImportHost(host)).toBe(true);
    }
  });

  it("blocks 0.0.0.0/8 and IPv6 link/unique-local", () => {
    expect(isBlockedImportHost("0.0.0.0")).toBe(true);
    expect(isBlockedImportHost("fe80::1")).toBe(true);
    expect(isBlockedImportHost("fc00::1")).toBe(true);
    expect(isBlockedImportHost("fd12:3456::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 pointing at a private address", () => {
    expect(isBlockedImportHost("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedImportHost("[::ffff:10.0.0.1]")).toBe(true);
  });

  it("allows ordinary public hosts and public IPs", () => {
    for (const host of [
      "example.com",
      "news.ycombinator.com",
      "8.8.8.8",
      "172.32.0.1", // just outside 172.16/12
      "192.169.0.1", // just outside 192.168/16
      "11.0.0.1", // just outside 10/8
    ]) {
      expect(isBlockedImportHost(host)).toBe(false);
    }
  });
});

describe("isImportableScheme", () => {
  it("allows http and https only", () => {
    expect(isImportableScheme("http:")).toBe(true);
    expect(isImportableScheme("https:")).toBe(true);
    expect(isImportableScheme("file:")).toBe(false);
    expect(isImportableScheme("ftp:")).toBe(false);
    expect(isImportableScheme("javascript:")).toBe(false);
  });
});
