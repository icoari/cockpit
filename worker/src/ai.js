// Workers AI — Whisper speech-to-text (paid plan).
//
//   /transcribe   Dictation used everywhere in Bob (health logging, writer,
//                 calendar events, voice notes). Runs on Cloudflare's GPU
//                 edge, no external API.
//
// (The former bge-m3 + Vectorize semantic-memory endpoints were removed when
// Mémoire became a local notes app — see modules/memory.js client-side.)

import { json } from './http.js';

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

// Base64 audio cap (~18 MB of raw audio) — far above any dictation clip.
const AUDIO_MAX_CHARS = 25 * 1024 * 1024;

// Body: { audio: <base64>, language?: 'fr' }
export async function handleTranscribe(request, env) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > AUDIO_MAX_CHARS + 1024) {
    return json({ error: 'audio too large' }, 413);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { audio, language } = body || {};
  if (typeof audio !== 'string' || audio.length < 16) {
    return json({ error: 'audio (base64) required' }, 400);
  }
  if (audio.length > AUDIO_MAX_CHARS) {
    return json({ error: 'audio too large' }, 413);
  }
  // Turbo accepts a language hint — pin it to French unless told otherwise so
  // short clips aren't mis-detected as English.
  let lang = 'fr';
  if (language !== undefined && language !== null && language !== '') {
    if (typeof language !== 'string' || !/^[a-z]{2}$/i.test(language)) {
      return json({ error: 'language must be a 2-letter ISO 639-1 code' }, 400);
    }
    lang = language.toLowerCase();
  }

  let res;
  try {
    res = await env.AI.run(WHISPER_MODEL, { audio, language: lang });
  } catch (err) {
    console.error('transcription failed', err);
    return json({ error: 'transcription failed' }, 502);
  }
  const text = (res?.text || '').trim();
  return json({ text });
}
