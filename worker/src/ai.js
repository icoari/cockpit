// Workers AI features — unlocked by the paid plan.
//
//   /transcribe     Whisper speech-to-text (dictation, e.g. writing on the
//                   train). Runs on Cloudflare's GPU edge, no external API.
//   /memory/index   Embed corpus chunks (bge-m3, multilingual) and store the
//                   VECTORS ONLY in Vectorize — never the text. The full text
//                   stays on the device, so semantic search stays as private
//                   as the rest of Bob's E2E model.
//   /memory/search  Embed the query, ask Vectorize for the nearest chunks,
//                   return their ids + scores. The client maps ids back to its
//                   own local text.
//   /memory/forget  Drop vectors for deleted chunks.
//
// Embedding model: @cf/baai/bge-m3 → 1024-dim, cosine. Matches the
// `bob-memory` Vectorize index.

const EMBED_MODEL = '@cf/baai/bge-m3';
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const EMBED_BATCH = 96;          // bge-m3 accepts up to 100 texts / call
const UPSERT_BATCH = 200;        // keep mutations comfortably small

// ---- helpers ----------------------------------------------------------

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function embed(env, texts) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH);
    const res = await env.AI.run(EMBED_MODEL, { text: slice });
    // bge-m3 returns { shape, data: [[...], ...] }
    for (const v of res.data) vectors.push(v);
  }
  return vectors;
}

// ---- /transcribe ------------------------------------------------------

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

// ---- /memory/index ----------------------------------------------------

// Body: { docs: [{ id, type, text, ts }] }
//   id   — stable, e.g. "chapter:<uid>" or "health:<eventId>"
//   type — "chapter" | "health" | ...
//   text — plaintext (embedded then DISCARDED, never stored)
//   ts   — epoch ms (for recency display client-side)
export async function handleMemoryIndex(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const docs = Array.isArray(body?.docs) ? body.docs : null;
  if (!docs) return json({ error: 'docs[] required' }, 400);
  if (docs.length === 0) return json({ ok: true, indexed: 0 });
  if (docs.length > 2000) return json({ error: 'too many docs (max 2000)' }, 413);

  const clean = docs.filter(d => d && typeof d.id === 'string' && typeof d.text === 'string' && d.text.trim());
  if (clean.length === 0) return json({ ok: true, indexed: 0 });

  // Embeddings work best on bounded text — clip each chunk.
  const texts = clean.map(d => d.text.slice(0, 2000));
  let vectors;
  try {
    vectors = await embed(env, texts);
  } catch (e) {
    return json({ error: 'embedding failed: ' + (e.message || e) }, 502);
  }

  const records = clean.map((d, i) => ({
    id: d.id,
    values: vectors[i],
    // Metadata holds NO text — only what's needed to filter + sort client-side.
    metadata: { type: String(d.type || 'note'), ts: Number(d.ts) || 0 },
  }));

  let count = 0;
  for (let i = 0; i < records.length; i += UPSERT_BATCH) {
    await env.VECTORIZE.upsert(records.slice(i, i + UPSERT_BATCH));
    count += Math.min(UPSERT_BATCH, records.length - i);
  }
  return json({ ok: true, indexed: count });
}

// ---- /memory/search ---------------------------------------------------

// Body: { query, topK?, type? }
export async function handleMemorySearch(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const query = (body?.query || '').toString().trim();
  if (!query) return json({ error: 'query required' }, 400);
  const topK = Math.min(Math.max(parseInt(body?.topK, 10) || 8, 1), 20);

  let qv;
  try {
    [qv] = await embed(env, [query]);
  } catch (e) {
    return json({ error: 'embedding failed: ' + (e.message || e) }, 502);
  }

  const opts = { topK, returnMetadata: 'all' };
  if (body?.type) opts.filter = { type: String(body.type) };

  let res;
  try {
    res = await env.VECTORIZE.query(qv, opts);
  } catch (e) {
    return json({ error: 'vector query failed: ' + (e.message || e) }, 502);
  }

  const matches = (res.matches || []).map(m => ({
    id: m.id,
    score: m.score,
    type: m.metadata?.type || 'note',
    ts: m.metadata?.ts || 0,
  }));
  return json({ matches });
}

// ---- /memory/forget ---------------------------------------------------

// Body: { ids: [...] }
export async function handleMemoryForget(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const ids = Array.isArray(body?.ids) ? body.ids.filter(x => typeof x === 'string') : null;
  if (!ids || !ids.length) return json({ error: 'ids[] required' }, 400);
  try {
    await env.VECTORIZE.deleteByIds(ids);
  } catch (e) {
    return json({ error: 'delete failed: ' + (e.message || e) }, 502);
  }
  return json({ ok: true, forgotten: ids.length });
}
