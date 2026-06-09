// LLM client — always transits through the Bob Worker because most managed
// endpoints (Azure OpenAI, Azure AI Foundry) don't expose CORS for browser
// direct calls. The Worker just forwards body + applies the right auth
// header upstream.
//
// Two upstream formats are supported:
//   - 'openai':    OpenAI-style /chat/completions  (works with LiteLLM, OpenAI,
//                  Azure OpenAI, Azure AI Foundry /models/chat/completions)
//   - 'anthropic': Anthropic /v1/messages          (Anthropic API, Azure AI
//                  Foundry /anthropic/v1/messages — needs api-version=…)
//
// Auth headers handled in the Worker:
//   - 'bearer' → Authorization: Bearer <key>      (OpenAI, LiteLLM)
//   - 'azure'  → api-key: <key>                   (Azure OpenAI, Azure AI Foundry)

import { getSettings } from './state.js';
import { WORKER_URL } from './sync.js';

export function isConfigured() {
  const c = getSettings().llm;
  return !!(c?.enabled && c.endpoint && c.apiKey);
}

function getConfig() {
  const c = getSettings().llm || {};
  if (!c.endpoint || !c.apiKey) throw new Error('Assistant non configuré. Va dans Réglages → Assistant.');
  return c;
}

function getSyncToken() {
  try {
    const raw = localStorage.getItem('bob-sync-v1');
    const s = raw ? JSON.parse(raw) : null;
    return s?.authToken || null;
  } catch { return null; }
}

// Build the body the upstream expects.
function buildBody(c, messages, opts) {
  const format = c.format || 'openai';

  if (format === 'anthropic') {
    // Extract any system messages — Anthropic uses a top-level field.
    const systemBits = messages.filter(m => m.role === 'system').map(m => m.content);
    const userMsgs = messages.filter(m => m.role !== 'system');
    const body = {
      model: c.model || 'claude-sonnet-4-5',
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      messages: userMsgs,
    };
    if (systemBits.length) body.system = systemBits.join('\n\n');
    if (opts.stream) body.stream = true;
    return body;
  }

  // OpenAI-compatible
  const body = {
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.stream) body.stream = true;
  if (c.model) body.model = c.model;
  if (opts.json) body.response_format = { type: 'json_object' };
  return body;
}

// Call the Worker proxy. Returns the raw Response so callers can stream.
async function callProxy(messages, opts) {
  const c = getConfig();
  const syncAuth = getSyncToken();
  if (!syncAuth) throw new Error('Active d\'abord la sauvegarde cloud — l\'assistant transite par ton Worker.');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${syncAuth}`,
    'X-LLM-Endpoint': c.endpoint,
    'X-LLM-Key': c.apiKey,
    'X-LLM-Auth-Style': c.authStyle || 'bearer',
    'X-LLM-Format': c.format || 'openai',
  };

  const resp = await fetch(`${WORKER_URL}/llm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(c, messages, opts)),
    signal: opts.signal,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} — ${txt.slice(0, 400)}`);
  }
  return resp;
}

// ---------- One-shot completion ----------

export async function complete(messages, opts = {}) {
  const resp = await callProxy(messages, { ...opts, stream: false });
  const data = await resp.json();
  return extractText(data, (getConfig().format || 'openai'));
}

function extractText(data, format) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(data.content) ? data.content : [];
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return data.choices?.[0]?.message?.content || '';
}

// ---------- Streaming ----------

export async function stream(messages, onChunk, opts = {}) {
  const c = getConfig();
  const format = c.format || 'openai';
  const resp = await callProxy(messages, { ...opts, stream: true });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';

  const handleEvent = (eventText) => {
    const parsed = parseEvent(eventText, format);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.delta) {
      full += parsed.delta;
      onChunk(parsed.delta, full);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = splitSSE(buf);
    buf = events.remainder;
    for (const ev of events.list) handleEvent(ev);
  }
  // Flush the decoder and process whatever's left — the final event isn't
  // always followed by a blank line.
  buf += dec.decode();
  if (buf.trim()) handleEvent(buf);
  return full;
}

// SSE framing: blank line separates events.
function splitSSE(buf) {
  const parts = buf.split(/\r?\n\r?\n/);
  const remainder = parts.pop() || '';
  return { list: parts, remainder };
}

function parseEvent(eventText, format) {
  // Multi-line "data:" fields join with a newline per the SSE spec.
  const lines = eventText.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  const dataStr = dataLines.join('\n').trim();
  if (!dataStr || dataStr === '[DONE]') return {};

  try {
    const obj = JSON.parse(dataStr);
    if (format === 'anthropic') {
      if (obj.type === 'error') {
        return { error: obj.error?.message || 'Erreur du modèle (stream)' };
      }
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
        return { delta: obj.delta.text || '' };
      }
      return {};
    }
    if (obj.error) return { error: obj.error.message || 'Erreur du modèle (stream)' };
    return { delta: obj.choices?.[0]?.delta?.content || '' };
  } catch { return {}; }
}

// ---------- Tiny ping ----------

export async function ping() {
  return complete(
    [{ role: 'user', content: 'reply with the single word: pong' }],
    { temperature: 0, maxTokens: 16 },
  );
}
