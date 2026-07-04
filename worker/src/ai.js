// Workers AI — Whisper speech-to-text (paid plan).
//
//   /transcribe   Dictation used everywhere in Bob (health logging, writer,
//                 calendar events, voice notes). Runs on Cloudflare's GPU
//                 edge, no external API.
//
// (The former bge-m3 + Vectorize semantic-memory endpoints were removed when
// Mémoire became a local notes app — see modules/memory.js client-side.)

const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

// Body: { audio: <base64>, language?: 'fr' }
export async function handleTranscribe(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const { audio, language } = body || {};
  if (typeof audio !== 'string' || audio.length < 16) {
    return json({ error: 'audio (base64) required' }, 400);
  }
  // ~33% base64 overhead; cap raw audio near 24 MB to stay well within limits.
  if (audio.length > 32 * 1024 * 1024) {
    return json({ error: 'audio too large' }, 413);
  }

  const input = { audio };
  // Turbo accepts a language hint — pin it to French unless told otherwise so
  // short clips aren't mis-detected as English.
  input.language = (typeof language === 'string' && language) ? language : 'fr';

  let res;
  try {
    res = await env.AI.run(WHISPER_MODEL, input);
  } catch (e) {
    return json({ error: 'transcription failed: ' + (e.message || e) }, 502);
  }
  const text = (res?.text || '').trim();
  return json({ text });
}
