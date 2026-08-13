'use strict';

// Ad hoc validation for #153 part 1 (library-grounded citation matching):
// does grounding a citation against the library entry's real excerpt text
// actually catch a misattribution that a title/source-only match would miss?
// Exercises the same prompt shape as server.js's groundAgainstLibraryText()
// directly against the Anthropic API — no Express server needed, so it
// doesn't collide with any dev server already running on the shared port.
// No test framework exists in this repo — matches its existing ad hoc
// script style (see scripts/test-director.js). Run with:
//   node scripts/test-library-grounding.js

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.join(__dirname, '..');

// Same walk-up as server.js's loadEnv() — worktrees keep .env at the main
// project root, not inside the worktree directory.
(function loadEnv() {
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      require('dotenv').config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadEntry(id) {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts/library/library.json'), 'utf8'));
  const entry = index.find(e => e.id === id);
  const raw = fs.readFileSync(path.join(ROOT, 'prompts/library', entry.file), 'utf8');
  const text = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  return { title: entry.title, source: entry.source, text };
}

async function groundAgainstLibraryText(items) {
  const system = `You are checking whether citations from a transcript are actually supported by the real source text they were matched to. This is a stricter check than general knowledge — treat each "Excerpt" below as ground truth, not your training data.

For each numbered item, judge whether its "Transcript quote" is genuinely consistent with its "Excerpt":
- "verified": the excerpt clearly supports the quote/claim as attributed
- "unverified": the excerpt contradicts it, or doesn't contain/support what's being attributed to it
- "uncertain": the excerpt doesn't clearly settle it either way (e.g. adjacent material, but not this specific claim)`;

  const itemsText = items
    .map(
      (item, index) =>
        `### Item ${index}\nWork cited: ${item.work}\nTranscript quote: "${item.quote}"\n\nExcerpt from "${item.entry.title}" (${item.entry.source}):\n${item.entry.text}`
    )
    .join('\n\n---\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: itemsText }],
    tools: [
      {
        name: 'report_grounded_verdicts',
        description: 'Report a text-grounded verdict for each numbered item.',
        input_schema: {
          type: 'object',
          properties: {
            verdicts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer', description: 'The item number from the prompt.' },
                  verdict: { type: 'string', enum: ['verified', 'unverified', 'uncertain'] },
                  note: { type: 'string', description: 'One-sentence reasoning, referencing the excerpt directly.' },
                },
                required: ['index', 'verdict', 'note'],
              },
            },
          },
          required: ['verdicts'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_grounded_verdicts' },
  });

  const block = response.content.find(b => b.type === 'tool_use');
  return block?.input?.verdicts || [];
}

async function main() {
  const arabi = loadEntry('arabi-imagination-fusus');

  const cases = [
    {
      label: 'accurate — should verify',
      work: 'Fusus al-Hikam',
      quote:
        'the imagination is not nonexistent, even though it has no real external existence, and the mystic who knows this does not need to abolish forms to reach unity',
      entry: arabi,
      expect: 'verified',
    },
    {
      label: 'misattributed — contradicts the excerpt, should NOT verify',
      work: 'Fusus al-Hikam',
      quote:
        'as I wrote in the Fusus, the imagination must be abolished entirely before the mystic can reach divine unity with God',
      entry: arabi,
      expect: 'unverified or uncertain',
    },
    {
      label: 'fabricated claim about a real work, should NOT verify',
      work: 'Fusus al-Hikam',
      quote: 'as I wrote in the Fusus, I once debated Aquinas in Cordoba about the nature of the Trinity',
      entry: arabi,
      expect: 'unverified or uncertain',
    },
  ];

  const verdicts = await groundAgainstLibraryText(cases);

  console.log(`${verdicts.length}/${cases.length} verdicts returned.\n`);
  let allPass = true;
  cases.forEach((c, i) => {
    const v = verdicts.find(x => x.index === i);
    const pass = v && (c.expect === 'verified' ? v.verdict === 'verified' : v.verdict !== 'verified');
    allPass = allPass && pass;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label}`);
    console.log(`  expected: ${c.expect} | got: ${v?.verdict || 'MISSING'}`);
    console.log(`  note: ${v?.note || '(none)'}\n`);
  });

  console.log(allPass ? 'All cases behaved as expected.' : 'Some cases did not behave as expected — see above.');
  process.exitCode = allPass ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
