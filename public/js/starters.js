'use strict';

// #623 — starters on the empty stage.
//
// The problem this replaces: a guest's first view of the app was "I. The
// Provocation — paste a document", with nothing to do unless they already had
// a question in hand. The Archival Library's curated excerpts were the obvious
// ready-made provocations, but they sat behind a dropdown. Principle 6: the
// resting state should be the room, not a form.
//
// Each starter is hand-curated (prompts/library/starters.json): a short
// provocation tied to one library excerpt, with a pre-cast room of 2-3
// members — small on purpose, so a first convene is cheap and individual
// voices stay distinct. One click seats that room, loads the excerpt as the
// provocation, and convenes live; "Let the room choose" and hand-casting
// remain available afterwards because this only drives the same state the
// normal flow uses.
//
// The cards sit under the resting stage; style.css hides them whenever
// #stage-record gains .stage-only (live convene) or .collapsed (restored
// session), so "starters disappear once a meeting is under way" needs no
// state of its own — and nothing here depends on localStorage.
//
// Same script-tag/IIFE convention as casting.js/witness.js (#142): one window
// global, no reads of app.js's core state except through configure()'s deps.
window.Starters = (function () {
  let deps = null; // set by configure(); see app.js's startersDeps()
  let busy = false; // a starter is already being seated/loaded/convened

  const MAX_CAST = 3;

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // Cast ids that aren't on the roster (a member removed since starters.json
  // was written) are dropped rather than failing the whole starter; the room
  // still convenes as long as two remain.
  function seatableCast(cast) {
    const { MEMBERS } = deps.getCore();
    const known = new Set(MEMBERS.map(m => m.id));
    return (cast || []).filter(id => known.has(id)).slice(0, MAX_CAST);
  }

  async function convene({ libraryId, cast }) {
    if (busy) return;
    const seated = seatableCast(cast);
    if (seated.length < 2) {
      deps.setStatus('That room could not be assembled — pick another starter.', false);
      return;
    }
    busy = true;
    try {
      const { activeMembers } = deps.getCore();
      activeMembers.clear();
      seated.forEach(id => activeMembers.add(id));
      // The cast is a deliberate choice: this stops the auto-proposal that a
      // document landing would otherwise spend a call on.
      deps.noteHandCast();
      deps.renderMembers();
      const loaded = await deps.selectLibraryEntry(libraryId);
      if (!loaded) {
        deps.setStatus('That excerpt could not be loaded — pick another starter.', false);
        return;
      }
      await deps.convene();
    } finally {
      busy = false;
    }
  }

  function conveneStarter(starter) {
    return convene({ libraryId: starter.libraryId, cast: starter.cast });
  }

  // "Surprise me": a random library entry, cast with the people the library
  // already associates it with. Needs two seatable members, so single-member
  // entries are skipped rather than padded with a guess.
  async function surprise() {
    if (busy) return;
    try {
      const entries = await fetch('/api/library').then(r => r.json());
      const candidates = (Array.isArray(entries) ? entries : []).filter(e => seatableCast(e.members).length >= 2);
      if (!candidates.length) {
        deps.setStatus('The archive has nothing to offer just now.', false);
        return;
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      await convene({ libraryId: pick.id, cast: pick.members });
    } catch (_) {
      deps.setStatus('The archive could not be reached.', false);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderCard(starter, nameOf) {
    const card = el('button', 'starter-card');
    card.type = 'button';
    card.appendChild(el('span', 'starter-hook', starter.hook));
    const meta = [starter.title, starter.date].filter(Boolean).join(' · ');
    card.appendChild(el('span', 'starter-source', meta));
    card.appendChild(el('span', 'starter-cast', starter.cast.map(nameOf).join(' · ')));
    card.addEventListener('click', () => conveneStarter(starter));
    return card;
  }

  // Fills #starters with the cards. A failure to fetch (unauthenticated,
  // offline) leaves the container empty and the page exactly as it was.
  async function render() {
    const root = document.getElementById('starters');
    if (!root) return;
    let data;
    try {
      const res = await fetch('/api/starters');
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return;
    }
    const starters = Array.isArray(data?.starters) ? data.starters : [];
    if (!starters.length) return;

    const { MEMBERS } = deps.getCore();
    const nameOf = id => MEMBERS.find(m => m.id === id)?.name || id;

    root.innerHTML = '';
    root.appendChild(el('div', 'starters-heading', 'Or begin with one of these'));

    const actions = el('div', 'starters-actions');
    const surpriseBtn = el('button', 'lodge-btn', '✦ Surprise me');
    surpriseBtn.type = 'button';
    surpriseBtn.addEventListener('click', surprise);
    actions.appendChild(surpriseBtn);
    // A published past sitting, read in the public reading room — zero API
    // cost. Only shown once starters.json names one.
    if (typeof data.sitting === 'string' && data.sitting) {
      const sitting = el('a', 'lodge-btn', 'Show me a sitting');
      sitting.href = `/reading-room/${encodeURIComponent(data.sitting)}`;
      sitting.target = '_blank';
      sitting.rel = 'noopener';
      actions.appendChild(sitting);
    }
    root.appendChild(actions);

    const list = el('div', 'starters-list');
    starters.forEach(s => list.appendChild(renderCard(s, nameOf)));
    root.appendChild(list);
  }

  return { configure, render, conveneStarter, surprise };
})();
