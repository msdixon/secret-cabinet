'use strict';

// #356 — the project-wide bibliography. See src/bibliography.js's header for
// how this document differs in shape from build-citation-manifest.js's
// review-oriented CITATION-MANIFEST.md: alphabetical by work rather than
// grouped by verdict severity, and split into Works Cited / Works Referenced
// (invoked, not quoted) / the library appendix rather than one flat list.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWorkKey,
  groupByWork,
  renderLibraryAppendix,
  buildBibliography,
  renderBibliographyPage,
} = require('../src/bibliography');

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

  await t.test('sorts multiple entries alphabetically by citation', () => {
    const out = renderLibraryAppendix([
      { id: 'b', title: 'Second', citation: 'Zeta, Second, 1930.' },
      { id: 'a', title: 'First', citation: 'Alpha, First, 1920.' },
    ]);
    assert.ok(out.indexOf('Alpha, First') < out.indexOf('Zeta, Second'));
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

// #495 — renderBibliographyPage is the HTML-rendering path added for #461
// (GET /bibliography). buildBibliography's tests above already exercise the
// shared data-shaping helpers (groupByWork, citationsForSession, the
// grounded-vs-raw-beat fallback); these mirror that same fixture style but
// assert against the HTML output specifically — the verdict-pill styling,
// grounded-link building, and escaping that only this path does.
test('renderBibliographyPage', async t => {
  await t.test('renders a full page skeleton with all three sections, even with nothing to show', () => {
    const out = renderBibliographyPage([], ROSTER, []);
    assert.match(out, /<!DOCTYPE html>/);
    assert.match(out, /<title>Bibliography — The Secret-Cabin-et<\/title>/);
    assert.match(out, /<h2>I\. Works Cited<\/h2>/);
    assert.match(out, /<h2>II\. Works Referenced/);
    assert.match(out, /<h2>III\. Appendix: The Cabinet's Library<\/h2>/);
    assert.match(out, /No citations captured yet\./);
    assert.match(out, /None captured yet\./);
    assert.match(out, /No curated library entries yet\./);
    assert.match(out, /Generated from 0 sessions on disk, 0 with a turn-level record/);
  });

  await t.test('singularizes "session" in the meta line for exactly one session', () => {
    const out = renderBibliographyPage([{ id: 's1', date: '1926-01-01', rounds: [] }], ROSTER, []);
    assert.match(out, /Generated from 1 session on disk, 0 with a turn-level record/);
  });

  await t.test('a grounded (library) citation gets the colored verdict pill and a linked source', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'a real quote',
              work: 'The Book of the Law',
              verdict: 'verified',
              source: 'library',
              libraryCitation: 'Crowley, The Book of the Law, 1904.',
              librarySourceUrl: 'https://example.com/book-of-the-law',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<span class="bib-verdict bib-verified">verified<\/span>/);
    assert.match(
      out,
      /grounded in: <a href="https:\/\/example\.com\/book-of-the-law" rel="noopener">Crowley, The Book of the Law, 1904\.<\/a>/
    );
    assert.match(out, /<blockquote class="bib-quote">a real quote<\/blockquote>/);
    assert.doesNotMatch(out, /self-reported/);
  });

  await t.test('falls back to an in-page library anchor when a grounded citation has no external source_url', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'q',
              work: 'The Book of the Law',
              verdict: 'verified',
              source: 'library',
              libraryCitation: 'Crowley, The Book of the Law, 1904.',
              libraryMatch: 'crowley-1',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, [{ id: 'crowley-1', title: 'The Book of the Law' }]);
    assert.match(out, /grounded in: <a href="#lib-crowley-1">Crowley, The Book of the Law, 1904\.<\/a>/);
  });

  await t.test('a web-grounded citation without a title falls back to the bare URL as link text', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'q',
              work: 'Some Web Work',
              verdict: 'uncertain',
              source: 'web',
              webSourceUrl: 'https://example.com/source',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(
      out,
      /grounded in: <a href="https:\/\/example\.com\/source" rel="noopener">https:\/\/example\.com\/source<\/a>/
    );
    assert.match(out, /<span class="bib-verdict bib-uncertain">uncertain<\/span>/);
  });

  await t.test('an ungrounded (model-knowledge) citation reads as self-reported, unstyled, and unlinked', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'q',
              work: 'Some Work',
              verdict: 'verified',
              source: 'model-knowledge',
              note: 'recalled from training',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<span class="bib-verdict-unchecked">self-reported: verified<\/span>/);
    assert.doesNotMatch(out, /bib-verdict bib-verified/, 'must not earn the colored pill despite verdict "verified"');
    assert.match(out, /<span class="bib-unchecked">not checked against any source<\/span>/);
  });

  await t.test('a citation with no source at all defaults to ungrounded, self-reported, uncertain-labelled', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        { memberId: 'crowley', text: 'a', citations: [{ quote: 'q', work: 'Some Work' }] },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<span class="bib-verdict-unchecked">self-reported: uncertain<\/span>/);
    assert.match(out, /captured at write time — not yet run through Verify Citations/);
  });

  await t.test('a citation with no quote omits the blockquote entirely', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        { memberId: 'crowley', text: 'a', citations: [{ work: 'Some Work', verdict: 'verified', source: 'library' }] },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.doesNotMatch(out, /<blockquote/);
  });

  await t.test('renders the invoked-not-quoted section separately, with its own note', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'yeats',
          text: 'a',
          invokedWorks: [{ work: "Corbin's reading of Ibn Arabi", note: 'named in passing' }],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<h3>Corbin&#39;s reading of Ibn Arabi<\/h3>/);
    assert.match(out, /invoked 1 time without a supporting quote — not independently verified\./);
    assert.match(out, /— named in passing/);
  });

  await t.test('renders the library appendix with license and source link, and an id for in-page anchoring', () => {
    const out = renderBibliographyPage([], ROSTER, [
      {
        id: 'crowley-1',
        title: 'The Revolt',
        source: 'The Confessions',
        citation: 'Crowley, The Confessions, 1929.',
        license: 'public-domain',
        source_url: 'https://example.com/confessions',
      },
    ]);
    assert.match(out, /<li id="lib-crowley-1">Crowley, The Confessions, 1929\./);
    assert.match(out, /<span class="bib-license">\(public-domain\)<\/span>/);
    assert.match(out, /<a href="https:\/\/example\.com\/confessions" rel="noopener">source<\/a>/);
  });

  await t.test('library entries without a frontmatter citation fall back to title/source/date, still escaped', () => {
    const out = renderBibliographyPage([], ROSTER, [
      { id: 'x', title: 'Untitled Work', source: 'Some Source', date: '1900' },
    ]);
    assert.match(out, /Untitled Work — <em>Some Source<\/em>, 1900/);
  });

  await t.test('a library entry with no id renders with no anchor id at all', () => {
    const out = renderBibliographyPage([], ROSTER, [{ title: 'No Id Work', source: 'Somewhere' }]);
    assert.match(out, /<li>No Id Work/);
  });

  await t.test('escapes HTML in citation quotes, work titles, notes, and speaker names — the XSS-adjacent path', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: '<script>alert(1)</script> & "quoted"',
              work: 'Work <b>Title</b> & Co',
              verdict: 'verified',
              source: 'library',
              note: 'a note with <i>tags</i> & an ampersand',
              libraryCitation: '<b>Bold Citation</b>',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.doesNotMatch(out, /<script>/);
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quoted&quot;/);
    assert.match(out, /<h3>Work &lt;b&gt;Title&lt;\/b&gt; &amp; Co<\/h3>/);
    assert.match(out, /a note with &lt;i&gt;tags&lt;\/i&gt; &amp; an ampersand/);
    assert.match(out, /&lt;b&gt;Bold Citation&lt;\/b&gt;/);
    assert.doesNotMatch(out, /<b>Bold Citation<\/b>/);
  });

  await t.test('escapes HTML in library appendix entries (title, citation, license, url)', () => {
    const out = renderBibliographyPage([], ROSTER, [
      {
        id: 'x',
        title: '<img src=x onerror=alert(1)>',
        source: 'Some & Source',
        citation: null,
        license: '<b>PD</b>',
        source_url: 'https://example.com/"><script>',
      },
    ]);
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(out, /Some &amp; Source/);
    assert.match(out, /&lt;b&gt;PD&lt;\/b&gt;/);
    assert.doesNotMatch(out, /<script>/);
  });

  await t.test(
    'falls back to always-on beat citations, same as the markdown path, when citationFlags never ran',
    () => {
      const sessions = [
        sessionWithCitations('s1', '1926-01-01', [
          {
            memberId: 'crowley',
            text: 'a',
            citations: [{ quote: 'q', work: 'Ungrounded Work', verdict: 'uncertain', note: 'n' }],
          },
        ]),
      ];
      const out = renderBibliographyPage(sessions, ROSTER, []);
      assert.match(out, /<h3>Ungrounded Work<\/h3>/);
    }
  );

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
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /A real reference\./);
    assert.doesNotMatch(out, /stale note/);
  });

  await t.test('an unverified verdict gets the unverified pill class', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            { quote: 'q', work: 'Some Work', verdict: 'unverified', source: 'library', libraryCitation: 'c.' },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<span class="bib-verdict bib-unverified">unverified<\/span>/);
  });

  await t.test('pluralizes "citation(s)" and invoked "time(s)" counts for more than one occurrence', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            { quote: 'q1', work: 'Same Work', verdict: 'verified', source: 'library', libraryCitation: 'c1.' },
            { quote: 'q2', work: 'Same Work', verdict: 'verified', source: 'library', libraryCitation: 'c2.' },
          ],
          invokedWorks: [{ work: 'Invoked Twice' }, { work: 'Invoked Twice' }],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<p class="bib-count">2 citations<\/p>/);
    assert.match(out, /invoked 2 times without a supporting quote — not independently verified\./);
  });

  await t.test('a library citation with no source_url and no in-page match renders as plain escaped text', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'q',
              work: 'Some Work',
              verdict: 'verified',
              source: 'library',
              libraryCitation: 'Plain <i>Citation</i>.',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /grounded in: Plain &lt;i&gt;Citation&lt;\/i&gt;\.(?!<\/a>)/);
    assert.doesNotMatch(out, /<a href="[^"]*">Plain/);
  });

  await t.test('a web-grounded citation with a title uses the title as link text, not the bare URL', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            {
              quote: 'q',
              work: 'Some Web Work',
              verdict: 'uncertain',
              source: 'web',
              webSourceUrl: 'https://example.com/page',
              webSourceTitle: 'A Nice Title',
            },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /<a href="https:\/\/example\.com\/page" rel="noopener">A Nice Title<\/a>/);
  });

  await t.test('a web source with only a title (no URL) renders as plain escaped text, not a link', () => {
    const sessions = [
      sessionWithCitations('s1', '1926-01-01', [
        {
          memberId: 'crowley',
          text: 'a',
          citations: [
            { quote: 'q', work: 'Some Web Work', verdict: 'uncertain', source: 'web', webSourceTitle: 'Title Only' },
          ],
        },
      ]),
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /grounded in: Title Only</);
    assert.doesNotMatch(out, /<a href="[^"]*">Title Only/);
  });

  await t.test('sorts multiple library appendix entries alphabetically by citation', () => {
    const out = renderBibliographyPage([], ROSTER, [
      { id: 'b', title: 'Second', citation: 'Zeta, Second, 1930.' },
      { id: 'a', title: 'First', citation: 'Alpha, First, 1920.' },
    ]);
    assert.ok(out.indexOf('Alpha, First') < out.indexOf('Zeta, Second'), 'sorted alphabetically, not insertion order');
  });

  await t.test('a library appendix entry with no date omits it from the fallback reference', () => {
    const out = renderBibliographyPage([], ROSTER, [{ id: 'x', title: 'No Date Work', source: 'Somewhere' }]);
    assert.match(out, /No Date Work — <em>Somewhere<\/em><\/li>/);
  });

  await t.test('renders missing date as an empty string rather than "undefined"', () => {
    const sessions = [
      {
        id: 's1',
        rounds: [
          {
            beats: [
              { memberId: 'crowley', text: 'a', citations: [{ quote: 'q', work: 'Some Work', verdict: 'verified' }] },
            ],
          },
        ],
      },
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /session <code>s1<\/code> \(\)/);
    assert.doesNotMatch(out, /undefined/);
  });

  await t.test('renders missing date as an empty string for an invoked (not quoted) occurrence too', () => {
    const sessions = [
      {
        id: 's1',
        rounds: [{ beats: [{ memberId: 'yeats', text: 'a', invokedWorks: [{ work: 'Some Tradition' }] }] }],
      },
    ];
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /session <code>s1<\/code> \(\)<\/span><\/li>/);
    assert.doesNotMatch(out, /undefined/);
  });

  await t.test('tolerates a session with no rounds property at all, rather than throwing', () => {
    const sessions = [{ id: 's1', date: '1926-01-01' }];
    assert.doesNotThrow(() => renderBibliographyPage(sessions, ROSTER, []));
    const out = renderBibliographyPage(sessions, ROSTER, []);
    assert.match(out, /Generated from 1 session on disk, 0 with a turn-level record/);
  });
});
