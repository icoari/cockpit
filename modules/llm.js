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
import { WORKER_URL, getSyncAuthToken } from './sync.js';

export function isConfigured() {
  const c = getSettings().llm;
  return !!(c?.enabled && c.endpoint && c.apiKey);
}

function getConfig() {
  const c = getSettings().llm || {};
  if (!c.endpoint || !c.apiKey) throw new Error('Assistant non configuré. Va dans Réglages → Assistant.');
  return c;
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

// Claude generations from Opus 4.7 / Sonnet 5 on reject sampling params
// (400 on temperature). Sonnet 5, Opus 4.7/4.8 and Opus 5 also think by
// default unless told not to, which can spend a short max_tokens on thinking
// and return no text. Fable and Opus 5.5 cannot turn thinking off at all.
const NO_SAMPLING = /claude-(sonnet-5|opus-4-[78]|opus-5|fable|mythos)/;
const CAN_DISABLE_THINKING = /claude-(sonnet-5|opus-4-[78]|opus-5(?!-5))/;
const ALWAYS_THINKS = /claude-(fable|mythos|opus-5-5)/;

// Build the body the upstream expects.
function buildBody(c, messages, opts) {
  const format = c.format || 'openai';

  if (format === 'anthropic') {
    // Extract any system messages — Anthropic uses a top-level field.
    const systemBits = messages.filter(m => m.role === 'system').map(m => m.content);
    const userMsgs = messages.filter(m => m.role !== 'system');
    // Azure Foundry deployments can carry any name: match on the model id
    // inside it, and fall back to the legacy behaviour when nothing matches.
    const model = c.model || DEFAULT_CLAUDE_MODEL;
    const id = model.toLowerCase();
    const body = {
      model,
      max_tokens: opts.maxTokens ?? 2048,
      messages: userMsgs,
    };
    if (!NO_SAMPLING.test(id)) body.temperature = opts.temperature ?? 0.3;
    if (CAN_DISABLE_THINKING.test(id)) body.thinking = { type: 'disabled' };
    if (ALWAYS_THINKS.test(id)) {
      body.output_config = { effort: 'low' };
      body.max_tokens = Math.max(body.max_tokens, 4096);
    }
    if (systemBits.length) body.system = systemBits.join('\n\n');
    if (opts.stream) body.stream = true;
    return body;
  }

  // OpenAI-compatible
  const body = {
    messages,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (!NO_SAMPLING.test((c.model || '').toLowerCase())) body.temperature = opts.temperature ?? 0.3;
  if (opts.stream) body.stream = true;
  if (c.model) body.model = c.model;
  return body;
}

// A deployment name can hide the model id, so the rules above may miss: when
// the upstream rejects a parameter by name, drop it and let the caller retry.
const DROPPABLE = ['temperature', 'top_p', 'thinking', 'output_config'];
function dropRejectedParams(body, errorText) {
  const t = (errorText || '').toLowerCase();
  let dropped = false;
  for (const k of DROPPABLE) {
    if (k in body && t.includes(k)) { delete body[k]; dropped = true; }
  }
  return dropped;
}

// Call the Worker proxy. Returns the raw Response so callers can stream.
async function callProxy(messages, opts) {
  const c = getConfig();
  const syncAuth = getSyncAuthToken();
  if (!syncAuth) throw new Error('Active d\'abord la sauvegarde cloud : l\'assistant transite par ton Worker.');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${syncAuth}`,
    'X-LLM-Endpoint': c.endpoint,
    'X-LLM-Key': c.apiKey,
    'X-LLM-Auth-Style': c.authStyle || 'bearer',
    'X-LLM-Format': c.format || 'openai',
  };

  const body = buildBody(c, messages, opts);
  const send = () => fetch(`${WORKER_URL}/llm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  let resp = await send();
  if (resp.status === 400) {
    const txt = await resp.text().catch(() => '');
    if (!dropRejectedParams(body, txt)) throw new Error(`HTTP 400 : ${txt.slice(0, 400)}`);
    resp = await send();
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} : ${txt.slice(0, 400)}`);
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

  try {
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
  } finally {
    // A thrown model error (or onChunk exception) must not leave the reader
    // locked and the connection open.
    try { reader.cancel(); } catch {}
  }
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
