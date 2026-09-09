'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const CURSOR_RECORD_BYTES = 16;

const SHAPE_CODES = { arrow: 0, ibeam: 1, pointinghand: 2, resize: 3 };
const SHAPE_NAMES = ['arrow', 'ibeam', 'pointinghand', 'resize'];

function createProject(source, capture) {
  return {
    version: SCHEMA_VERSION,
    source,
    capture,
    zoomKeyframes: [],
    cursorTrack: 'cursor.bin',
    clicks: [],
    speedSegments: [],
    voiceover: [],
    settings: {
      preserveVoicePitch: true,
      clickHighlights: true,
      cursorSmoothing: true,
      rampMs: 200
    },
    export: { resolution: '1080p', fps: 60, codec: 'h264' }
  };
}

function saveProject(dir, project) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
}

function loadProject(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  if (raw.version !== SCHEMA_VERSION) {
    throw new Error(`unsupported project version: ${raw.version}`);
  }
  return raw;
}

function writeCursorTrack(dir, track) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(track.length * CURSOR_RECORD_BYTES);
  track.forEach((s, i) => {
    const at = i * CURSOR_RECORD_BYTES;
    buf.writeFloatLE(s.t, at);
    buf.writeFloatLE(s.x, at + 4);
    buf.writeFloatLE(s.y, at + 8);
    buf.writeUInt8(SHAPE_CODES[s.shape] ?? SHAPE_CODES.arrow, at + 12);
  });
  fs.writeFileSync(path.join(dir, 'cursor.bin'), buf);
}

function readCursorTrack(dir) {
  const file = path.join(dir, 'cursor.bin');
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const out = [];
  for (let at = 0; at + CURSOR_RECORD_BYTES <= buf.length; at += CURSOR_RECORD_BYTES) {
    out.push({
      t: buf.readFloatLE(at),
      x: buf.readFloatLE(at + 4),
      y: buf.readFloatLE(at + 8),
      shape: SHAPE_NAMES[buf.readUInt8(at + 12)] ?? 'arrow'
    });
  }
  return out;
}

const CAMERA_RECORD_BYTES = 16;

function writeCameraTrack(dir, samples) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(samples.length * CAMERA_RECORD_BYTES);
  samples.forEach((s, i) => {
    const at = i * CAMERA_RECORD_BYTES;
    buf.writeFloatLE(s.t, at);
    buf.writeFloatLE(s.zoom, at + 4);
    buf.writeFloatLE(s.cx, at + 8);
    buf.writeFloatLE(s.cy, at + 12);
  });
  fs.writeFileSync(path.join(dir, 'camera.bin'), buf);
}

function readCameraTrack(dir) {
  const file = path.join(dir, 'camera.bin');
  if (!fs.existsSync(file)) return [];
  const buf = fs.readFileSync(file);
  const out = [];
  for (let at = 0; at + CAMERA_RECORD_BYTES <= buf.length; at += CAMERA_RECORD_BYTES) {
    out.push({
      t: buf.readFloatLE(at),
      zoom: buf.readFloatLE(at + 4),
      cx: buf.readFloatLE(at + 8),
      cy: buf.readFloatLE(at + 12)
    });
  }
  return out;
}

module.exports = {
  createProject, saveProject, loadProject,
  writeCursorTrack, readCursorTrack,
  writeCameraTrack, readCameraTrack,
  SCHEMA_VERSION, CURSOR_RECORD_BYTES, CAMERA_RECORD_BYTES, SHAPE_CODES
};
