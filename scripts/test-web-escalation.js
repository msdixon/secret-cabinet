'use strict';

// Live-network validation for #153 part 2 (web-escalation): for citations with
// no library match, does a real lookup against open-data sources (archive.org,
// Wikisource, Wikipedia, Wikidata) actually confirm/deny rather than just
// trusting the model's memory? test/citations.test.js covers this path offline
// with fakes; this is the one check against the real services. No Anthropic
// call involved — it calls the shipping escalateCitationToWeb() from
// src/citations.js directly (#598; it used to carry a private copy that would
// have kept passing against stale logic).
// No test framework exists in this repo — matches its existing ad hoc
// script style (see scripts/test-director.js). Run with:
//   node scripts/test-web-escalation.js

const { escalateCitationToWeb } = require('../src/citations');

async function main() {
  const cases = [
    {
      label: 'real quote, correctly-named work — should confirm via some tier, never wrongly land on the wrong book',
      work: 'The Interpretation of Dreams',
      quote: 'the interpretation of dreams is the royal road to a knowledge of the unconscious',
      note: 'orig note',
      check: r => r && r.source === 'web',
    },
    {
      label:
        'famous phrase misattributed to an unrelated invented work — must NOT confirm just because the phrase exists somewhere',
      work: 'Some Unrelated Nonexistent Treatise on Bee Farming',
      quote: 'it was the best of times, it was the worst of times',
      note: 'orig note',
      check: r => !r || r.verdict !== 'verified',
    },
    {
      label: 'real historical figure, general claim — existence-only tier, must stay uncertain not verified',
      work: 'Jacob Boehme',
      quote: 'the fire is the father of light',
      note: 'orig note',
      check: r => r && r.source === 'web' && r.verdict === 'uncertain',
    },
    {
      label:
        'wholly fabricated work and quote — clean miss (falls back to model verdict) or graceful error-degrade, never falsely verified',
      work: 'Xyzzptlk Fnord Grimoire of Nonexistence',
      quote: 'this quote does not exist anywhere at all zzz999',
      note: 'orig note',
      check: r => !r || r.verdict !== 'verified',
    },
  ];

  let allPass = true;
  for (const c of cases) {
    const result = await escalateCitationToWeb(c);
    const pass = c.check(result);
    allPass = allPass && pass;
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.label}`);
    console.log(
      `  result: ${result ? JSON.stringify({ verdict: result.verdict, source: result.source, webSourceTitle: result.webSourceTitle }) : 'null (clean miss)'}\n`
    );
  }

  console.log(allPass ? 'All cases behaved as expected.' : 'Some cases did not behave as expected — see above.');
  process.exitCode = allPass ? 0 : 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
