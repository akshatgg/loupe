'use strict';

const BASE = 'x-apple.systempreferences:com.apple.preference.security';

const PANES = {
  screenRecording: `${BASE}?Privacy_ScreenCapture`,
  accessibility: `${BASE}?Privacy_Accessibility`,
  microphone: `${BASE}?Privacy_Microphone`
};

function createPermissions({ systemPreferences, shell }) {
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

module.exports = { createPermissions, PANES };
