// Turn a locally chosen video into a short, muted, downscaled background loop.
// The source file never leaves the device and is never uploaded: the browser
// decodes it, frames are drawn to a canvas, and MediaRecorder re-encodes only
// the seconds we keep. A 30s clip lands around 5-15 MB instead of 375 MB, so
// the upload is a single request that a phone can actually finish.

const MIME_ORDER = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function clipMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return MIME_ORDER.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

export function clipSupported() {
  return typeof HTMLCanvasElement.prototype.captureStream === 'function' && !!clipMime();
}

function once(target, event, errorEvent = 'error') {
  return new Promise((resolve, reject) => {
    const ok = e => { cleanup(); resolve(e); };
    const bad = () => { cleanup(); reject(new Error(`video ${errorEvent}`)); };
    const cleanup = () => {
      target.removeEventListener(event, ok);
      target.removeEventListener(errorEvent, bad);
    };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener(errorEvent, bad, { once: true });
  });
}

// even dimensions: H.264 encoders reject odd width/height
const even = n => Math.max(2, Math.round(n / 2) * 2);

export async function makeClip(file, opts = {}) {
  const seconds = opts.seconds || 30;
  const maxWidth = opts.maxWidth || 960;
  const onProgress = opts.onProgress || (() => {});
  const mimeType = clipMime();
  if (!clipSupported()) throw new Error('this browser cannot trim video');

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;            // audio is dropped entirely — canvas carries video only
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';

  let raf = 0;
  let recorder;
  try {
    await once(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const span = duration ? Math.min(seconds, duration) : seconds;
    // default a little way in: rips usually open on a title card
    const wanted = opts.startAt ?? Math.min(30, duration * 0.1);
    const startAt = duration ? Math.min(Math.max(0, wanted), Math.max(0, duration - span)) : 0;

    if (startAt > 0) {
      video.currentTime = startAt;
      await once(video, 'seeked');
    }

    const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
    const canvas = document.createElement('canvas');
    canvas.width = even((video.videoWidth || maxWidth) * scale);
    canvas.height = even((video.videoHeight || maxWidth * 9 / 16) * scale);
    const ctx = canvas.getContext('2d', { alpha: false });

    const stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });

    recorder.start(1000);
    await video.play();

    const started = performance.now();
    const endsAt = started + span * 1000;
    await new Promise(resolve => {
      const draw = now => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        onProgress(Math.min(1, (now - started) / (span * 1000)));
        // stop on wall clock, or early if the source ran out
        if (now >= endsAt || video.ended) { resolve(); return; }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    });

    recorder.stop();
    stream.getTracks().forEach(t => t.stop());
    await stopped;
    if (!chunks.length) throw new Error('nothing was recorded');
    return new Blob(chunks, { type: mimeType.split(';')[0] });
  } finally {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch { /* already stopping */ } }
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
