'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Ad-hoc sign the macOS bundle after packaging, when there is no Developer ID
 * certificate to sign it properly (see electron-builder.config.js).
 *
 * Without this the app is reported as **damaged** on any Mac that downloads
 * it -- a hard refusal with only "Move to Bin", not the bypassable
 * "unidentified developer" warning. `mac.identity: null` makes
 * electron-builder skip signing, yet the Electron binary inside keeps its own
 * ad-hoc signature, so the bundle claims to be signed while its seal
 * describes different contents; Gatekeeper reads that as tampering. Signing
 * the assembled bundle here, with the real bundle identifier, gives a
 * consistent seal. Apple Silicon also refuses to run unsigned code at all.
 *
 * The bundled Swift helpers (Contents/Resources/bin) keep the ad-hoc
 * signature the linker gave each architecture slice, and are covered by the
 * app's seal as resources.
 *
 * Same approach as Souffleur's build/afterPack.js.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) return; // electron-builder signs for real

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const bundleId = context.packager.appInfo.id;

  console.log(`  • ad-hoc signing  ${appName} as ${bundleId}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', bundleId, appPath],
    { stdio: 'inherit' });

  // Fail the build rather than ship something macOS will call damaged.
  execFileSync('codesign', ['--verify', '--strict', '--deep', appPath], { stdio: 'inherit' });
  console.log('  • signature verified');
};
