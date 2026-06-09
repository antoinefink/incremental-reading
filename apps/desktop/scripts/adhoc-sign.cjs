/**
 * electron-builder `afterPack` hook — ad-hoc code-sign the packed macOS .app.
 *
 * WHY THIS EXISTS (the "Interleave is damaged and can't be opened" bug, v0.1.1):
 * On Apple Silicon the kernel refuses to LOAD any arm64 executable without a
 * VALID code signature — independent of Gatekeeper/quarantine. Prebuilt Electron
 * ships with a linker-applied ad-hoc signature, but electron-builder's packaging
 * (asar + resource staging) modifies the bundle and INVALIDATES that seal. The
 * shipped bundle then has `Sealed Resources=none` / `Info.plist=not bound` and
 * fails `codesign --verify`, which Gatekeeper surfaces as "is damaged" (the harsh
 * class — not "unidentified developer", and NOT bypassable via right-click→Open).
 *
 * electron-builder won't fix this for us here: with `mac.identity: null` it skips
 * signing, and with `identity: "-"` (v25.1.8) it treats "-" as a NAMED keychain
 * identity, finds none, and ALSO skips ("skipped macOS application code signing …
 * no valid identity with this name"). So we re-seal the bundle ourselves with a
 * real ad-hoc signature here, after the bundle is fully staged and before the DMG
 * is built.
 *
 * This does NOT remove the end-user step: an ad-hoc-signed app downloaded via a
 * browser is still quarantined, so the user runs
 *   xattr -dr com.apple.quarantine /Applications/Interleave.app
 * once (see RELEASE.md). Ad-hoc signing satisfies the kernel's code-integrity
 * requirement; the xattr removal satisfies Gatekeeper's quarantine check. Real
 * Developer ID signing + notarization (no xattr step) is a later release task.
 *
 * `--deep` is used deliberately: the prebuilt Electron bundle has nested helper
 * apps + frameworks that each need a valid ad-hoc seal, and there is no real
 * identity/entitlements here for which inside-out staged signing would matter.
 * It is the pragmatic correct tool for a pure ad-hoc re-seal of a third-party
 * (Electron) bundle we did not build inside-out ourselves.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
exports.default = async function adhocSign(context) {
  // macOS only — no signing concept for the other platforms we don't ship anyway.
  if (context.electronPlatformName !== "darwin") return;

  // RELEASE BUILDS: skip the ad-hoc re-seal entirely. When INTERLEAVE_RELEASE_SIGN=1
  // (set by `pnpm dist:release`), electron-builder.config.cjs configures a real
  // Developer ID identity + hardened runtime, and electron-builder signs the bundle
  // itself AFTER this afterPack hook. An ad-hoc `codesign --force --deep --sign -`
  // here would just be overwritten — worse, the `--deep` re-seal can leave nested
  // helpers in a state the inside-out Developer ID signing then has to repair. So we
  // get out of the way and let electron-builder own signing + notarization.
  if (process.env.INTERLEAVE_RELEASE_SIGN === "1") {
    console.log(
      "[adhoc-sign] release signing active (INTERLEAVE_RELEASE_SIGN=1) — skipping ad-hoc re-seal; electron-builder will sign with the Developer ID identity.",
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename; // "Interleave"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[adhoc-sign] re-sealing ${appPath} with an ad-hoc signature (identity "-")`);
  // --force: replace the invalidated linker seal. --deep: re-sign nested helpers
  // + frameworks. --sign -: ad-hoc (no identity). No --options runtime / no
  // hardened runtime — those require a real Developer ID + notarization.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });

  // Fail the BUILD (not the user) if the seal still doesn't validate — this is the
  // gate that would have caught the original "damaged" ship.
  console.log("[adhoc-sign] verifying the signature is valid…");
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  console.log(
    "[adhoc-sign] ✓ valid ad-hoc signature — the app will launch on arm64 after quarantine removal.",
  );
};
