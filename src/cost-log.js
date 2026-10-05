'use strict';

// #594 — cost attribution, logging only (decided 2026-09-21: tag each
// Anthropic and ElevenLabs call with the user id; no metering, no limits).
//
// Anthropic calls happen in seven places across the pipeline, several
// levels below any route handler that knows who the caller is. Rather than
// threading a userId parameter through every one of them, the request's
// user rides along in AsyncLocalStorage (set once per request in server.js,
// right after requireAuth) and the shared Anthropic client is wrapped so
// every messages.create/stream call logs one line with whoever is current.
// A call made outside any request (scripts, startup) logs user=none.
//
// ElevenLabs has a single call site that already has req in hand
// (routes/voice.js), so it calls logCost directly.

const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

function runWithUser(userId, fn) {
  return requestContext.run({ userId: userId || null }, fn);
}

function currentUserId() {
  return requestContext.getStore()?.userId || null;
}

// One grep-able line per billable call: `[cost] user=<id> provider=<p> k=v...`.
function formatCostLine(userId, provider, fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  return `[cost] user=${userId || 'none'} provider=${provider}${parts.length ? ' ' + parts.join(' ') : ''}`;
}

// #624: an optional second destination for each event, so spend can be
// summed in-app (src/spend.js). A failing sink must never fail a billable call.
let costSink = null;
function setCostSink(fn) {
  costSink = fn;
}

function logCost(userId, provider, fields, log = console.log) {
  log(formatCostLine(userId, provider, fields));
  if (costSink) {
    try {
      costSink({ userId, provider, fields });
    } catch (err) {
      console.error(`[cost] sink failed: ${err.message}`);
    }
  }
}

function anthropicFields(model, usage) {
  return {
    model,
    in: usage?.input_tokens,
    out: usage?.output_tokens,
    cache_read: usage?.cache_read_input_tokens,
    cache_write: usage?.cache_creation_input_tokens,
  };
}

// Wraps client.messages.create and client.messages.stream in place. The
// userId is captured when the call is made, not when it finishes, so a
// stream that outlives its async context still logs against the right user.
// A failed call logs nothing — it was either not billed or will surface as
// an error elsewhere.
function instrumentAnthropicClient(client, log = console.log) {
  const messages = client.messages;
  const create = messages.create.bind(messages);
  const stream = messages.stream.bind(messages);

  messages.create = (params, ...rest) => {
    const userId = currentUserId();
    const promise = create(params, ...rest);
    promise.then(
      response => response?.usage && logCost(userId, 'anthropic', anthropicFields(params.model, response.usage), log),
      () => {}
    );
    return promise;
  };

  messages.stream = (params, ...rest) => {
    const userId = currentUserId();
    const s = stream(params, ...rest);
    s.on('finalMessage', message => logCost(userId, 'anthropic', anthropicFields(params.model, message.usage), log));
    return s;
  };

  return client;
}

module.exports = { setCostSink, runWithUser, currentUserId, formatCostLine, logCost, instrumentAnthropicClient };
