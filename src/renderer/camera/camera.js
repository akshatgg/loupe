// The webcam bubble (see src/main/ipc/camera.js for the whole lifecycle and
// the clock alignment). Shows the camera as soon as the window opens, and
// records it to webcam.webm when main says the screen recording started,
// sending the file to main a second at a time.

const camera = window.loupe.camera;
const video = document.getElementById('video');
const message = document.getElementById('message');

const MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const TIMESLICE_MS = 1000;

let stream = null;
let recorder = null;
let startedAt = 0;
// Chunk sends in order, so camera:stopped is only sent after the last one.
let sending = Promise.resolve();

function show(text) {
  message.textContent = text;
  message.hidden = false;
}

async function openCamera(deviceId) {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...size, deviceId: { exact: deviceId } }, audio: false
      });
    } catch (err) {
      // The chosen camera was unplugged: the default one will do.
      if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: size, audio: false });
}

function friendly(err) {
  if (err.name === 'NotAllowedError') return 'Loupe is not allowed to use the camera';
  if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'No camera found';
  if (err.name === 'NotReadableError') return 'The camera is busy in another app';
  return 'The camera could not start';
}

function startRecording() {
  if (!stream || recorder) return;
  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    sending = sending
      .then(() => e.data.arrayBuffer())
      .then((buf) => camera.chunk(new Uint8Array(buf)))
      .catch(() => {});
  };
  recorder.onstart = (e) => {
    // How long ago, on this page's clock, recording started: main subtracts
    // it from its own clock on arrival.
    startedAt = e.timeStamp;
    const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
    camera.started({
      startedAgoMs: Math.max(0, performance.now() - e.timeStamp),
      width: settings.width, height: settings.height
    });
  };
  recorder.onstop = () => {
    const durationMs = performance.now() - startedAt;
    sending.then(() => camera.stopped({ durationMs }));
  };
  recorder.onerror = () => camera.error({ message: 'The camera stopped recording' });
  recorder.start(TIMESLICE_MS);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else camera.stopped({});
}

camera.onCommand(({ action }) => {
  if (action === 'start') startRecording();
  else if (action === 'stop') stopRecording();
});

try {
  const init = await camera.init();
  stream = await openCamera(init?.deviceId ?? null);
  video.srcObject = stream;
  // A camera unplugged mid-recording ends its track: say so, and let main
  // carry on without it.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    camera.error({ message: 'The camera was disconnected' });
  });
} catch (err) {
  show(friendly(err));
  camera.error({ message: friendly(err) });
}
