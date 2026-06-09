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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = splitSSE(buf);
    buf = events.remainder;
    for (const ev of events.list) {
      const delta = parseDelta(ev, format);
      if (delta) {
        full += delta;
        onChunk(delta, full);
      }
    }
  }
  return full;
}

// SSE framing: blank line separates events.
function splitSSE(buf) {
  const parts = buf.split(/\r?\n\r?\n/);
  const remainder = parts.pop() || '';
  return { list: parts, remainder };
}

function parseDelta(eventText, format) {
  // Each event has one or more "data:" lines.
  const lines = eventText.split(/\r?\n/);
  let dataLine = '';
  for (const line of lines) {
    if (line.startsWith('data:')) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return '';
  if (dataLine === '[DONE]') return '';

  try {
    const obj = JSON.parse(dataLine);
    if (format === 'anthropic') {
      // Anthropic SSE: event types include content_block_delta with
      // delta = { type: 'text_delta', text: '...' }
      if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
        return obj.delta.text || '';
      }
      return '';
    }
    // OpenAI SSE: choices[0].delta.content
    return obj.choices?.[0]?.delta?.content || '';
  } catch { return ''; }
}

// ---------- Tiny ping ----------

export async function ping() {
  return complete(
    [{ role: 'user', content: 'reply with the single word: pong' }],
    { temperature: 0, maxTokens: 16 },
  );
}
