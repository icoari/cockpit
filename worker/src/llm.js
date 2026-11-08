// /llm — authenticated transparent proxy to any OpenAI-compatible
// chat-completions endpoint (Azure OpenAI, Azure AI Foundry / Anthropic,
// LiteLLM, OpenAI). Required because most managed LLM endpoints don't
// expose CORS for browser direct calls.
//
// Headers expected (all from the client):
//   Authorization:     Bearer <user sync token>
//   X-LLM-Endpoint:    full upstream URL (public https host, no IP literal)
//   X-LLM-Key:         upstream API key
//   X-LLM-Auth-Style:  'bearer' | 'azure'   (default: bearer)
//   X-LLM-Format:      'openai' | 'anthropic' (default: openai)

import { json, requireAuth, readBodyLimited } from './http.js';
import { isPublicHttpsUrl } from './url.js';

const LLM_MAX_BODY_BYTES = 1024 * 1024;
// Applies until the upstream answers with headers only; a streamed body
// may then run as long as the generation lasts.
const LLM_HEADERS_TIMEOUT_MS = 120_000;

export async function handleLlm(request, env) {
  const denied = await requireAuth(request, env);
  if (denied) return denied;

  const endpoint = request.headers.get('X-LLM-Endpoint');
  const upstreamKey = request.headers.get('X-LLM-Key');
  const authStyle = (request.headers.get('X-LLM-Auth-Style') || 'bearer').toLowerCase();
  const format = (request.headers.get('X-LLM-Format') || 'openai').toLowerCase();

  if (!endpoint || !upstreamKey) {
    return json({ error: 'missing X-LLM-Endpoint or X-LLM-Key' }, 400);
  }
  if (!isPublicHttpsUrl(endpoint)) {
    return json({ error: 'endpoint must be a public https URL' }, 400);
  }

  const { bytes, response } = await readBodyLimited(request, LLM_MAX_BODY_BYTES);
  if (response) return response;

  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (authStyle === 'azure') upstreamHeaders['api-key'] = upstreamKey;
  else upstreamHeaders['Authorization'] = `Bearer ${upstreamKey}`;

  // Anthropic Messages API needs an anthropic-version header. Azure AI Foundry
  // expects the same header when going through /anthropic/v1/messages.
  if (format === 'anthropic') {
    upstreamHeaders['anthropic-version'] = '2023-06-01';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_HEADERS_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: upstreamHeaders,
      body: bytes,
      signal: controller.signal,
    });
  } catch (err) {
    console.error('llm upstream fetch failed', err);
    return json({ error: 'upstream fetch failed' }, 502);
  } finally {
    clearTimeout(timer);
  }

  // Pass through the response — including streaming bodies — to the client.
  const ct = upstream.headers.get('Content-Type') || 'application/json';
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'no-store',
    },
  });
}
