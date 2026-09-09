'use strict';

// electron-builder afterSign hook. Notarizes the built .app with Apple's
// notary service so Gatekeeper will let it run on other people's Macs.
//
// This intentionally does NOT fail the build when notarization credentials
// are absent (e.g. local/dev builds, CI without secrets configured) — it
// logs and skips instead. A build that silently produced an unnotarized app
// while claiming success would be worse than one that is honest about being
// skipped. Signing (via electron-builder's own codesign step, driven by
// mac.hardenedRuntime + entitlements) still happens independently of this
// script whenever a Developer ID identity is present in the keychain.
module.exports = async function notarize(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;

  const hasPasswordAuth = appleId && appleIdPassword && teamId;
  const hasProfileAuth = keychainProfile;

  if (!hasPasswordAuth && !hasProfileAuth) {
    console.log(
      '[notarize] Skipping notarization: no Apple credentials in the ' +
        'environment (need APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + ' +
        'APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE). This build will not ' +
        'pass Gatekeeper on another machine.'
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  // Required only on the path that actually notarizes, so a build with no
  // credentials never needs the package installed.
  const { notarize: runNotarize } = require('@electron/notarize');

  console.log(`[notarize] Submitting ${appPath} for notarization...`);
  await runNotarize({
    appPath,
    ...(hasProfileAuth
      ? { keychainProfile }
      : { appleId, appleIdPassword, teamId })
  });
  console.log('[notarize] Notarization complete.');
};
