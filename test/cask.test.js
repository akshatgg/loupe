'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { renderCask } = require('../packaging/update-cask');

const ARM = 'a'.repeat(64);
const INTEL = 'b'.repeat(64);

test('the cask points each architecture at its own DMG for that version', () => {
  const rb = renderCask({ version: '0.2.0', armSha: ARM, intelSha: INTEL });
  assert.match(rb, /^cask "loupe" do$/m);
  assert.match(rb, /version "0\.2\.0"/);
  assert.match(rb, new RegExp(`on_arm do\\n\\s+sha256 "${ARM}"\\n\\s+url "https://github.com/akshatgg/loupe/releases/download/v#\\{version\\}/Loupe-arm64.dmg"`));
  assert.match(rb, new RegExp(`on_intel do\\n\\s+sha256 "${INTEL}"\\n\\s+url "https://github.com/akshatgg/loupe/releases/download/v#\\{version\\}/Loupe-x64.dmg"`));
});

test('the cask requires Sonoma (the capture helper does) and clears quarantine', () => {
  const rb = renderCask({ version: '0.2.0', armSha: ARM, intelSha: INTEL });
  assert.match(rb, /depends_on macos: :sonoma$/m);
  assert.match(rb, /xattr",\s+args: \["-dr", "com\.apple\.quarantine", "#\{appdir\}\/Loupe\.app"\]/);
  assert.match(rb, /uninstall quit: "tech\.markai\.loupe"/);
});

test('a bad hash or version never makes it into a cask', () => {
  assert.throws(() => renderCask({ version: '0.2.0', armSha: 'nope', intelSha: INTEL }));
  assert.throws(() => renderCask({ version: 'v0.2.0', armSha: ARM, intelSha: INTEL }));
});
