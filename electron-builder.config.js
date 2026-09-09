'use strict';
module.exports = {
  appId: 'tech.markai.loupe',
  productName: 'Loupe',
  directories: { output: 'dist', buildResources: 'packaging' },
  files: ['src/**/*', 'package.json'],
  extraResources: [{ from: 'bin', to: 'bin' }],
  mac: {
    category: 'public.app-category.video',
    target: ['dmg'],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Loupe records your microphone when you turn it on before recording.',
      NSCameraUsageDescription: 'Not used.'
    }
  },
  afterSign: 'packaging/notarize.js'
};
