// Speech-to-text via the Worker's Whisper endpoint (Workers AI).
//
// Records a short clip with MediaRecorder, ships the bytes to /transcribe,
// and returns the French transcription. Designed for hands-busy / on-the-move
// capture — dictate a paragraph on the train, drop it straight into a chapter.

import { WORKER_URL } from './sync.js';

function getSyncToken() {
  try {
    const raw = localStorage.getItem('bob-sync-v1');
    const s = raw ? JSON.parse(raw) : null;
    return s?.authToken || null;
  } catch { return null; }
}

export function voiceSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

// Pick a mime type the browser actually supports. iOS Safari → mp4/aac,
// most others → webm/opus. Whisper handles both.
function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg'];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const res = fr.result || '';
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// A live recorder you start/stop. onStop receives the transcribed text (or
// throws). Keeps the UI in control of timing.
export class VoiceRecorder {
  constructor() {
    this.rec = null;
    this.stream = null;
    this.chunks = [];
    this.mime = '';
  }

  async start() {
    if (!voiceSupported()) throw new Error('Micro non disponible sur cet appareil.');
    this.stream = await acquireMic();
    this.mime = pickMime();
    this.chunks = [];
    this.rec = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime })
                         : new MediaRecorder(this.stream);
    this.rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    });
    this.rec.start();
  }

  // Stop recording and resolve with the transcribed text.
  async stopAndTranscribe() {
    const done = new Promise((resolve) => {
      if (!this.rec) return resolve(new Blob());
      this.rec.addEventListener('stop', () => {
        resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' }));
      }, { once: true });
    });
    try { this.rec?.stop(); } catch {}
    const blob = await done;
    this._teardown();
    if (!blob.size) throw new Error('Aucun son capté.');
    return transcribeBlob(blob);
  }

  cancel() {
    try { this.rec?.stop(); } catch {}
    this._teardown();
  }

  _teardown() {
    // Keep the shared mic stream alive (released on idle) so we don't re-prompt
    // for permission on every recording — just drop the recorder.
    this.rec = null;
    this.stream = null;
    this.chunks = [];
    scheduleMicRelease();
  }
}

// ---- Shared mic stream --------------------------------------------------
// Acquire the microphone once and reuse it across recordings so iOS doesn't
// re-prompt every time. Released automatically after a stretch of inactivity
// so the "mic in use" indicator doesn't linger forever.
let sharedStream = null;
let releaseTimer = null;
const MIC_IDLE_RELEASE_MS = 90_000;

async function acquireMic() {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  const live = sharedStream && sharedStream.getAudioTracks().some(t => t.readyState === 'live');
  if (live) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return sharedStream;
}

function scheduleMicRelease() {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(releaseMic, MIC_IDLE_RELEASE_MS);
}

export function releaseMic() {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  try { sharedStream?.getTracks().forEach(t => t.stop()); } catch {}
  sharedStream = null;
}

export async function transcribeBlob(blob) {
  const token = getSyncToken();
  if (!token) throw new Error('Active la sauvegarde cloud — la dictée transite par ton Worker.');
  const audio = await blobToBase64(blob);

  const resp = await fetch(`${WORKER_URL}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ audio, language: 'fr' }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Transcription HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.text || '').trim();
}
