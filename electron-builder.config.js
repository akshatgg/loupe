'use strict';

/**
 * Build configuration (npm run dist:mac).
 *
 * A JS config rather than a block in package.json because signing adapts to
 * whatever credentials are present. With a Developer ID certificate in the
 * environment the build signs, and notarizes if Apple credentials are there
 * too; without one it falls back to a consistent ad-hoc signature
 * (packaging/afterPack.js) that still installs. Adding certificates later
 * needs no code change -- in CI they are repository secrets:
 *
 *   CSC_LINK                     base64 .p12 (Developer ID Application), or a path
 *   CSC_KEY_PASSWORD             its password
 *   APPLE_ID                     Apple ID for notarization
 *   APPLE_APP_SPECIFIC_PASSWORD  app-specific password
 *   APPLE_TEAM_ID                team identifier
 *
 * macOS only: capture, the zoom gesture and export are Swift helpers built on
 * ScreenCaptureKit / CGEventTap / AVFoundation (src/native), so there is no
 * Windows build to produce yet.
 */

const hasMacCert = Boolean(process.env.CSC_LINK);

module.exports = {
  appId: 'tech.markai.loupe',
  productName: 'Loupe',
  copyright: 'Copyright (c) 2026 akshatgg',
  directories: { output: 'dist', buildResources: 'packaging' },
  files: ['src/**/*', 'package.json'],
  // Universal (arm64 + x86_64) helpers from packaging/build-native.sh, so the
  // same bin/ serves both DMGs.
  extraResources: [{ from: 'bin', to: 'bin' }],
  afterPack: 'packaging/afterPack.js',
  // Notarizing needs a Developer ID signature underneath it; without one
  // there is nothing to notarize (notarize.js also skips without credentials).
  afterSign: hasMacCert ? 'packaging/notarize.js' : undefined,

  mac: {
    category: 'public.app-category.video',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    // Version-less names, so https://github.com/akshatgg/loupe/releases/latest/download/Loupe-arm64.dmg
    // always serves the newest release and the website never goes stale.
    artifactName: '${productName}-${arch}.${ext}',
    icon: 'packaging/icon.png',
    // SCContentFilter.pointPixelScale (Capture.swift) needs Sonoma.
    minimumSystemVersion: '14.0',

    // null = do not sign; afterPack then applies a consistent ad-hoc
    // signature. With a certificate, electron-builder signs properly.
    identity: hasMacCert ? undefined : null,
    hardenedRuntime: hasMacCert,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Loupe records your microphone when you turn it on before recording.',
      NSCameraUsageDescription: 'Not used.'
    }
  },

  dmg: {
    title: 'Loupe ${version}',
    contents: [
      { x: 140, y: 200, type: 'file' },
      { x: 400, y: 200, type: 'link', path: '/Applications' }
    ]
  }
};
