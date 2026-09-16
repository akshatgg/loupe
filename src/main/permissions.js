'use strict';

const BASE = 'x-apple.systempreferences:com.apple.preference.security';

const PANES = {
  screenRecording: `${BASE}?Privacy_ScreenCapture`,
  accessibility: `${BASE}?Privacy_Accessibility`,
  microphone: `${BASE}?Privacy_Microphone`
};

// Windows privacy settings: only the microphone is gated there. Screen
// capture and the input hooks the zoom gesture uses need no grant.
const WINDOWS_PANES = {
  microphone: 'ms-settings:privacy-microphone'
};

function createPermissions({ systemPreferences, shell, platform = process.platform }) {
  if (platform === 'win32') return createWindowsPermissions({ systemPreferences, shell });

  const screenRecording = () => systemPreferences.getMediaAccessStatus('screen') === 'granted';
  const accessibility = () => systemPreferences.isTrustedAccessibilityClient(false) === true;
  const microphone = () => systemPreferences.getMediaAccessStatus('microphone') === 'granted';

  return {
    screenRecording,
    accessibility,
    microphone,
    requestMicrophone: () => systemPreferences.askForMediaAccess('microphone'),

    // Recording depends on Screen Recording alone. A missing Accessibility
    // grant costs the zoom gesture and nothing else (PRD FR-14).
    canRecord: () => screenRecording(),
    canZoom: () => screenRecording() && accessibility(),

    openPane(name) {
      const url = PANES[name];
      if (!url) throw new Error(`unknown settings pane: ${name}`);
      return shell.openExternal(url);
    }
  };
}

function createWindowsPermissions({ systemPreferences, shell }) {
  // 'denied' when the user (or policy) switched off microphone access for
  // desktop apps; anything else and Windows lets the capture open it.
  const microphone = () => systemPreferences.getMediaAccessStatus('microphone') !== 'denied';
  return {
    screenRecording: () => true,
    accessibility: () => true,
    microphone,
    // Windows has no per-app prompt for desktop apps to raise.
    requestMicrophone: async () => microphone(),
    canRecord: () => true,
    canZoom: () => true,
    openPane(name) {
      const url = WINDOWS_PANES[name];
      if (!url) throw new Error(`unknown settings pane: ${name}`);
      return shell.openExternal(url);
    }
  };
}

module.exports = { createPermissions, PANES, WINDOWS_PANES };
