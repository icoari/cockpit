// LLM client — works against any OpenAI-compatible /chat/completions
// endpoint (LiteLLM proxy, OpenAI, Anthropic-on-Bedrock proxies) and the
// Azure OpenAI / Azure AI Foundry path which uses `api-key` header rather
// than `Authorization: Bearer`.
//
// Config lives in `getSettings().llm`:
//   {
//     enabled, endpoint, apiKey,
//     model,        // body field, ignored by pure Azure (deployment is in URL)
//     authStyle,    // 'bearer' | 'azure'
//   }

import { getSettings } from './state.js';

export function isConfigured() {
  const c = getSettings().llm;
  return !!(c?.enabled && c.endpoint && c.apiKey);
}

function getConfig() {
  const c = getSettings().llm || {};
  if (!c.endpoint || !c.apiKey) throw new Error('Assistant non configuré. Va dans Réglages → Assistant.');
  return c;
}

function buildHeaders(c) {
  const h = { 'Content-Type': 'application/json' };
  if (c.authStyle === 'azure') h['api-key'] = c.apiKey;
  else h['Authorization'] = `Bearer ${c.apiKey}`;
  return h;
}

function buildBody(c, messages, opts) {
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

// One-shot completion. Returns the assistant message content as a string.
export async function complete(messages, opts = {}) {
  const c = getConfig();
  const resp = await fetch(c.endpoint, {
    method: 'POST',
    headers: buildHeaders(c),
    body: JSON.stringify(buildBody(c, messages, opts)),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Erreur ${resp.status} — ${txt.slice(0, 240)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// Streaming completion. Pass `onChunk(text)` to receive incremental tokens.
export async function stream(messages, onChunk, opts = {}) {
  const c = getConfig();
  const resp = await fetch(c.endpoint, {
    method: 'POST',
    headers: buildHeaders(c),
    body: JSON.stringify(buildBody(c, messages, { ...opts, stream: true })),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Erreur ${resp.status} — ${txt.slice(0, 240)}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onChunk(delta, full);
        }
      } catch { /* skip non-JSON lines */ }
    }
  }
  return full;
}

// Tiny ping — checks endpoint+key+model without burning tokens.
export async function ping() {
  return complete(
    [{ role: 'user', content: 'reply with the single word: pong' }],
    { temperature: 0, maxTokens: 6 },
  );
}
