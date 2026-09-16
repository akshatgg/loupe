// Voiceover (project field audio.voiceover = [{ id, file, source, t, volume }]).
//
// A voiceover clip is anchored to a moment of a recording (source + source
// time), not to a position on the output timeline, so trimming or speeding up
// something earlier moves the clip along with the picture it talks about.
//
// Pure helpers (editor + exporter):
//   anchorAt(tl, outT)                        -> { source, t }
//   createVoiceover({ file, tl, outT, ... })  -> project entry
//   placeVoiceovers(items, tl, decoded, opts) -> mix.js tracks in output time
//
// Renderer only (uses browser media APIs, injected so tests can fake them):
//   startVoiceoverRecording(options)          -> recording controller
//   saveVoiceover(blob, loupe)                -> { file } via IPC 'voiceover:save'
//
// Clips always play at normal speed, even over a sped-up stretch: speech at
// 2x is unintelligible, and the person recorded it watching the output.

export function anchorAt(tl, outT) {
  const at = tl.toSource(Math.max(0, Math.min(outT, tl.duration)));
  return { source: at.source, t: at.t };
}

let idCounter = 0;
const newId = () => `vo-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function createVoiceover({ file, tl, outT, volume = 1, id = newId() }) {
  if (typeof file !== 'string' || !file) throw new TypeError('file is required');
  return { id, file, ...anchorAt(tl, outT), volume };
}

// decoded: Map or plain object from item id -> { channels, sampleRate }.
// Items whose moment was cut out, that start after the end, or that have no
// decoded audio are left out. Clips are cut at `duration` (the end of the
// video) rather than making the export longer.
export function placeVoiceovers(items, tl, decoded, { duration = tl.duration } = {}) {
  const get = (id) => (decoded instanceof Map ? decoded.get(id) : decoded?.[id]);
  const tracks = [];
  for (const item of items ?? []) {
    const audio = get(item.id);
    if (!audio) continue;
    const startOffset = tl.toOutput(item.source, item.t);
    if (startOffset === null || startOffset === undefined || startOffset >= duration) continue;
    const length = audio.channels[0].length / audio.sampleRate;
    tracks.push({
      id: item.id,
      channels: audio.channels,
      sampleRate: audio.sampleRate,
      startOffset,
      duration: Math.min(length, duration - startOffset),
      volume: item.volume ?? 1
    });
  }
  return tracks.sort((a, b) => a.startOffset - b.startOffset);
}

// ---------------------------------------------------------------------------
// Recording from the microphone.

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];

export function pickMimeType(MediaRecorderImpl) {
  return PREFERRED_TYPES.find((t) => MediaRecorderImpl.isTypeSupported?.(t)) ?? '';
}

// Starts recording right away. Echo cancellation stays on because the video
// usually plays (out loud) while someone talks over it; auto gain is off
// because levelling happens at export, where it can see the whole take.
//
// Returns {
//   mimeType,
//   level(): 0..1 peak of the last ~50 ms, for a input meter (0 without AudioContext),
//   elapsed(): seconds recorded,
//   stop(): Promise<{ blob, mimeType, duration }>,
//   cancel(): stops and discards
// }
export async function startVoiceoverRecording({
  deviceId,
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  AudioContextImpl = globalThis.AudioContext,
  now = () => globalThis.performance.now()
} = {}) {
  if (!mediaDevices?.getUserMedia || !MediaRecorderImpl) {
    throw new Error('Recording from a microphone isn’t available here.');
  }
  const stream = await mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  });
  const mimeType = pickMimeType(MediaRecorderImpl);
  const recorder = new MediaRecorderImpl(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  let ctx = null;
  let analyser = null;
  let buf = null;
  if (AudioContextImpl) {
    try {
      ctx = new AudioContextImpl();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      buf = new Float32Array(analyser.fftSize);
      ctx.createMediaStreamSource(stream).connect(analyser);
    } catch {
      ctx = null;
      analyser = null;
    }
  }

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    ctx?.close?.();
  };

  const startedAt = now();
  let stoppedAt = null;
  // A timeslice makes chunks arrive during recording, so a crash mid-take
  // loses at most a second rather than everything.
  recorder.start(1000);

  return {
    mimeType: recorder.mimeType || mimeType,
    level() {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
      return Math.min(1, p);
    },
    elapsed: () => ((stoppedAt ?? now()) - startedAt) / 1000,
    stop() {
      return new Promise((resolve, reject) => {
        if (recorder.state === 'inactive') {
          reject(new Error('This recording has already stopped.'));
          return;
        }
        recorder.onstop = () => {
          stoppedAt = now();
          release();
          const type = recorder.mimeType || mimeType || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mimeType: type, duration: (stoppedAt - startedAt) / 1000 });
        };
        recorder.onerror = (e) => { release(); reject(e.error ?? new Error('Recording failed.')); };
        recorder.stop();
      });
    },
    cancel() {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      chunks.length = 0;
      release();
    }
  };
}

// Sends the take to the main process, which writes it into the project
// folder and returns its path relative to the project (for the `file` field).
export async function saveVoiceover(blob, loupe = globalThis.window?.loupe) {
  if (!loupe?.saveVoiceover) throw new Error('Saving a voiceover isn’t available here.');
  const data = new Uint8Array(await blob.arrayBuffer());
  return loupe.saveVoiceover({ data, mimeType: blob.type });
}
