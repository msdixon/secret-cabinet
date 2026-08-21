'use strict';

// #356 — the project-wide bibliography. See src/bibliography.js's header for
// how this document differs in shape from build-citation-manifest.js's
// review-oriented CITATION-MANIFEST.md: alphabetical by work rather than
// grouped by verdict severity, and split into Works Cited / Works Referenced
// (invoked, not quoted) / the library appendix rather than one flat list.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeWorkKey, groupByWork, renderLibraryAppendix, buildBibliography } = require('../src/bibliography');

const ROSTER = [
  { id: 'crowley', name: 'Crowley' },
  { id: 'yeats', name: 'Yeats' },
];

function sessionWithCitations(id, date, beats) {
  return { id, date, rounds: [{ beats }] };
}

test('normalizeWorkKey', async t => {
  await t.test('strips quote marks/asterisks and collapses whitespace/case for grouping', () => {
    assert.equal(normalizeWorkKey('*The Book of the Law*'), 'the book of the law');
    assert.equal(normalizeWorkKey('"The   Book of the Law"'), 'the book of the law');
  });
});

test('groupByWork', async t => {
  await t.test('dedups the same work across sessions and orders alphabetically, not by severity', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [{ quote: 'q', work: 'Zeta Text', verdict: 'unverified', note: 'n' }],
        },
      ]),
      sessionWithCitations('s2', '1926-01-02', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [{ quote: 'q', work: 'Alpha Text', verdict: 'verified', note: 'n' }],
        },
        {
          memberId: 'yeats',
          text: 'b',
          citations: [{ quote: 'q2', work: 'Alpha Text', verdict: 'verified', note: 'n' }],
        },
      ]),
    ];
    const groups = groupByWork(sessions, ROSTER, (s, r) =>
      (s.rounds || []).flatMap(seg =>
        (seg.beats || []).flatMap(b =>
          (b.citations || []).map(c => ({ ...c, speaker: r.find(m => m.id === b.memberId)?.name }))
        )
      )
    );
    assert.deepEqual(
      groups.map(g => g.displayWork),
      ['Alpha Text', 'Zeta Text'],
      'alphabetical ordering, not the unverified-first severity ordering CITATION-MANIFEST.md uses'
    );
    assert.equal(groups[0].occurrences.length, 2, 'both Alpha Text occurrences merge into one group');
  });

  await t.test('skips an entry with no usable work name', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        { memberId: 'crowley', text: 'a', citations: [{ quote: 'q', work: '' }] },
      ]),
    ];
    const groups = groupByWork(sessions, ROSTER, s =>
      (s.rounds || []).flatMap(seg => (seg.beats || []).flatMap(b => b.citations || []))
    );
    assert.equal(groups.length, 0);
  });
});

test('renderLibraryAppendix', async t => {
  await t.test("renders each entry's publication-ready citation string when present", () => {
    const out = renderLibraryAppendix([
      {
        id: 'crowley-1',
        title: 'The Revolt',
        source: 'The Confessions',
        citation: 'Crowley, The Confessions, 1929.',
        license: 'public-domain',
      },
    ]);
    assert.match(out, /Crowley, The Confessions, 1929\./);
    assert.match(out, /public-domain/);
  });

  await t.test('falls back to title/source/date when an entry has no frontmatter citation', () => {
    const out = renderLibraryAppendix([{ id: 'x', title: 'Untitled Work', source: 'Some Source', date: '1900' }]);
    assert.match(out, /Untitled Work/);
    assert.match(out, /Some Source/);
    assert.match(out, /1900/);
  });

  await t.test('says so honestly when there are no library entries yet', () => {
    assert.match(renderLibraryAppendix([]), /No curated library entries yet/);
  });
});

test('buildBibliography', async t => {
  await t.test('separates Works Cited from Works Referenced (invoked, not quoted)', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [{ quote: 'a real quote', work: 'The Book of the Law', verdict: 'verified', note: 'It exists.' }],
          invokedWorks: [{ work: "Corbin's reading of Ibn Arabi", note: 'named in passing' }],
        },
      ]),
    ];
    const out = buildBibliography(sessions, ROSTER, []);
    assert.match(out, /## I\. Works Cited/);
    assert.match(out, /### The Book of the Law/);
    assert.match(out, /> "a real quote"/);
    assert.match(out, /## II\. Works Referenced/);
    assert.match(out, /### Corbin's reading of Ibn Arabi/);
    assert.match(out, /invoked 1 time without a supporting quote — not independently verified/);
    // the invoked tier must never carry a quote block — that's exactly the
    // distinction the issue asks this document to keep honest.
    const worksReferencedSection = out.slice(out.indexOf('## II.'));
    assert.doesNotMatch(worksReferencedSection, /> "/);
  });

  await t.test('falls back to always-on beat citations when a session has never been through Verify Citations', () => {
    // #355/#356: this is the exact bug PROJECT.md flagged — a session with
    // captured-but-ungrounded citations must still show up, not render an
    // empty bibliography just because citationFlags was never written.
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [{ quote: 'q', work: 'Ungrounded Work', verdict: 'uncertain', note: 'n' }],
        },
      ]),
    ];
    const out = buildBibliography(sessions, ROSTER, []);
    assert.match(out, /### Ungrounded Work/);
    assert.match(out, /captured at write time — not yet run through Verify Citations/);
  });

  await t.test('prefers grounded citationFlags over the raw beat capture when both exist', () => {
    const sessions = [
      {
        id: 's1',
        date: '1926-01-01',
        citationFlags: [
          {
            quote: 'q',
            work: 'Grounded Work',
            verdict: 'verified',
            note: 'n',
            speaker: 'Crowley',
            source: 'library',
            libraryCitation: 'A real reference.',
          },
        ],
        rounds: [
          {
            beats: [
              {
                memberId: 'crowley',
                text: 'a',
                citations: [{ quote: 'stale', work: 'Grounded Work', verdict: 'uncertain', note: 'stale note' }],
              },
            ],
          },
        ],
      },
    ];
    const out = buildBibliography(sessions, ROSTER, []);
    assert.match(out, /A real reference\./);
    assert.doesNotMatch(out, /stale note/);
  });

  await t.test('says so honestly when nothing has been cited or invoked yet', () => {
    const out = buildBibliography([{ id: 's1', date: '1926-01-01', rounds: [] }], ROSTER, []);
    assert.match(out, /No citations captured yet/);
    assert.match(out, /None captured yet/);
  });

  await t.test('includes the curated library as its own appendix section', () => {
    const out = buildBibliography([], ROSTER, [
      { id: 'crowley-1', title: 'The Revolt', source: 'The Confessions', citation: 'Crowley, The Confessions, 1929.' },
    ]);
    assert.match(out, /Appendix: The Cabinet's Library/);
    assert.match(out, /Crowley, The Confessions, 1929\./);
  });
});
