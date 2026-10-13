'use strict';

// Shared fake Anthropic clients for the pipeline tests (#629). Before this
// file, test/pipeline.test.js hand-rolled nine near-identical
// `{ messages: { create, stream } }` fakes; they differed by one or two
// parameters each, so they are now all built from the factories below.

const TOOL_USAGE = { input_tokens: 100, output_tokens: 20 };
const CONSULT_USAGE = { input_tokens: 10, output_tokens: 5 };
const DISPOSITION_USAGE = { input_tokens: 8, output_tokens: 4 };
const STREAM_USAGE = { input_tokens: 20, output_tokens: 10 };

// Entry `i` of a per-call pattern; once it runs out, the last entry repeats.
// Undefined for an empty pattern.
function clampedAt(pattern, i) {
  return pattern[Math.min(i, pattern.length - 1)];
}

// A text stream: one text delta, then finalMessage() carrying usage.
function textStream(text, usage = STREAM_USAGE) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
    },
    finalMessage: async () => ({ usage }),
  };
}

// A stream that yields `text` and then dies mid-flight, as a dropped
// connection would.
function failingStream(text, message = 'connection reset mid-stream') {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      throw new Error(message);
    },
    finalMessage: async () => {
      throw new Error(message);
    },
  };
}

// Answers a single forced tool call with `reply` and records what it was
// asked in `.asked`. `reply` may be a function of the call number (1-based);
// an Error (returned or as the reply itself) is thrown instead.
function fakeToolCallClient(reply, { usage = TOOL_USAGE } = {}) {
  const asked = [];
  return {
    asked,
    messages: {
      create: async req => {
        asked.push(req);
        const r = typeof reply === 'function' ? reply(asked.length) : reply;
        if (r instanceof Error) throw r;
        return { content: [{ type: 'tool_use', input: r }], usage };
      },
    },
  };
}

// Minimal streaming client for callSpeakerTurn.
function fakeStreamingClient({ text = 'a turn', usage = { input_tokens: 50, output_tokens: 10 } } = {}) {
  const asked = [];
  return {
    asked,
    messages: {
      stream: req => {
        asked.push(req);
        return textStream(text, usage);
      },
    },
  };
}

// Full runRound surface: director consults (select_speakers), disposition
// calls (update_disposition) and speaker streams.
//   windingDownOnConsult  windingDown flag per select_speakers call (clamped)
//   consultExtras(i)      extra fields merged into consult i's tool input
//                         (e.g. splinterPair, confessional)
//   dispositionInput      the update_disposition tool input
//   dispositionError      throw this from the disposition call instead
//   stream(req, n)        replace the speaker stream (n = 1-based stream count)
// Records `.asked` (every create request) and `.streamMaxTokens`.
function fakeConsultClient({
  speakers = ['crowley'],
  speakerText = 'A turn.',
  windingDownOnConsult = [false],
  lullNote = null,
  consultExtras = () => ({}),
  dispositionInput = { reflection: 'Considering.', waitingOnMemberId: 'none' },
  dispositionError = null,
  stream = null,
} = {}) {
  let selectCalls = 0;
  let streamCalls = 0;
  const asked = [];
  const streamMaxTokens = [];
  return {
    asked,
    streamMaxTokens,
    messages: {
      create: async req => {
        asked.push(req);
        if (req.tools?.[0]?.name === 'select_speakers') {
          const windingDown = clampedAt(windingDownOnConsult, selectCalls);
          const extras = consultExtras(selectCalls);
          selectCalls++;
          return {
            content: [
              {
                type: 'tool_use',
                input: { speakers, reasoning: 'r', windingDown, lullNote: windingDown ? lullNote : null, ...extras },
              },
            ],
            usage: CONSULT_USAGE,
          };
        }
        if (dispositionError) throw dispositionError;
        return { content: [{ type: 'tool_use', input: dispositionInput }], usage: DISPOSITION_USAGE };
      },
      stream: req => {
        streamCalls++;
        streamMaxTokens.push(req.max_tokens);
        return stream ? stream(req, streamCalls) : textStream(speakerText);
      },
    },
  };
}

module.exports = { clampedAt, textStream, failingStream, fakeToolCallClient, fakeStreamingClient, fakeConsultClient };
