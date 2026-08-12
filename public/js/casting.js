'use strict';

// #185 — casting: the director proposes, the user keeps regulars.
//
// The problem this replaces: every session opened on 33 unselected tokens and
// a "0 present" badge, so the first thing the app asked of you was a casting
// chore — in a room whose own conceit is that "no one decides to come."
//
// Deliberately a hybrid, not auto-casting. Two mechanisms, in this order:
//
//   1. REGULARS — members pinned as always-invited, persisted in
//      localStorage and seated the moment the page loads. Hand-casting
//      favourites is a feature here, not a bug to design out; this is the
//      part that makes "Yeats and Crowley are always at this table" a
//      standing fact instead of 33 clicks a week.
//   2. THE PROPOSAL — when a document lands, one cheap pre-convene call asks
//      the director who *that document* would draw, seeded with the regulars
//      as fixed. The answer is a suggestion: it renders as a one-click
//      accept and applies nothing until accepted.
//
// The full member grid is untouched and still authoritative. Once the user
// hand-casts anyone, the auto-proposal stops firing for that document —
// nothing overwrites a deliberate choice — though "Ask the room" still works
// on demand.
//
// Same script-tag/IIFE convention as witness.js/export.js/sessions.js (#142):
// one window global, no reads of app.js's core state except through the
// `deps` bag handed over by configure().
window.Casting = (function () {
  let deps = null; // set by configure(); see app.js's castingDeps()

  const REGULARS_KEY = 'sc-regulars';

  // Enough of the document to tell two pastes apart without keeping a second
  // copy of it around; guards the one-call-per-document promise.
  const DOC_FINGERPRINT_CHARS = 400;

  let regulars = loadRegulars();
  let proposal = null; // { cast, additions, regulars, reasoning, source }
  let pending = false;
  let handCast = false; // the user has touched the grid for this document
  let proposedFor = null; // fingerprint of the document last proposed on
  let lastMetrics = []; // #225 — usage from the most recent /api/cast call,
  // held here until app.js's convene call claims it

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // ── Regulars ───────────────────────────────────────────────────────────────

  function loadRegulars() {
    try {
      const raw = JSON.parse(localStorage.getItem(REGULARS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
    } catch (_) {
      return []; // a corrupted key should cost the pins, not the page
    }
  }

  function saveRegulars() {
    try {
      localStorage.setItem(REGULARS_KEY, JSON.stringify(regulars));
    } catch (_) {}
  }

  function getRegulars() {
    return [...regulars];
  }

  function isRegular(id) {
    return regulars.includes(id);
  }

  // Pinning seats the member immediately — "always invited" would be a
  // strange promise to make and then not keep for the session you made it in.
  // Unpinning does the reverse only if they haven't otherwise been cast this
  // session, which is why it clears rather than asks: an unpinned member who
  // is mid-session present stays present.
  function toggleRegular(id) {
    const { activeMembers } = deps.getCore();
    if (regulars.includes(id)) {
      regulars = regulars.filter(r => r !== id);
      activeMembers.delete(id);
    } else {
      regulars = [...regulars, id];
      activeMembers.add(id);
    }
    saveRegulars();
    deps.renderMembers();
  }

  // Called once at startup, after the roster arrives. Unknown ids (a member
  // removed from the roster since they were pinned) are dropped from the
  // stored list rather than silently carried forever.
  function seatRegulars() {
    const { activeMembers, MEMBERS } = deps.getCore();
    const known = new Set(MEMBERS.map(m => m.id));
    const kept = regulars.filter(id => known.has(id));
    if (kept.length !== regulars.length) {
      regulars = kept;
      saveRegulars();
    }
    kept.forEach(id => activeMembers.add(id));
  }

  // ── Hand-casting ───────────────────────────────────────────────────────────

  // app.js calls this from the member token's own click handler, so it means
  // exactly "the user cast someone by hand" — not "activeMembers changed",
  // which is also true of seatRegulars() and acceptProposal().
  function noteHandCast() {
    handCast = true;
    render();
  }

  // ── The proposal ───────────────────────────────────────────────────────────

  function fingerprint(text) {
    return `${text.length}:${text.slice(0, DOC_FINGERPRINT_CHARS)}`;
  }

  // `auto` — fired by a document landing rather than by a button. Auto calls
  // yield to a hand-cast room and never repeat for the same document; the
  // explicit button honours neither restriction.
  async function requestProposal({ auto = false } = {}) {
    if (pending) return;
    const entry = deps.getEntry();
    if (!entry) {
      if (!auto) deps.setStatus('The room needs a document before it can say who it would draw.', false);
      return;
    }

    const fp = fingerprint(entry);
    if (auto && (handCast || proposedFor === fp)) return;
    proposedFor = fp;

    pending = true;
    proposal = null;
    render();

    try {
      const res = await fetch('/api/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry, regulars: getRegulars() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read the room');
      proposal = data;
      lastMetrics = Array.isArray(data.metrics) ? data.metrics : [];
    } catch (e) {
      proposal = null;
      lastMetrics = [];
      // A failed proposal is a non-event: the grid still works, and an auto
      // attempt the user never asked for shouldn't take over the status bar.
      if (!auto) deps.setStatus(`The room could not be read — ${e.message}`, false);
      proposedFor = null; // let a retry through
    } finally {
      pending = false;
      render();
    }
  }

  function acceptProposal() {
    if (!proposal) return;
    const { activeMembers } = deps.getCore();
    activeMembers.clear();
    proposal.cast.forEach(id => activeMembers.add(id));
    proposal = null;
    render(); // this panel is ours to clear, not renderMembers()'s
    deps.renderMembers();
    deps.setStatus('The room has assembled. Convene when you are ready.', false);
  }

  function dismissProposal() {
    proposal = null;
    render();
  }

  // #225 — app.js calls this once, right before /api/convene, to fold the
  // casting call's usage into the new session's generationMetrics. Clears on
  // read so a later convene (a different document, a hand-cast room) doesn't
  // pick up a stale call it never made.
  function consumeMetrics() {
    const metrics = lastMetrics;
    lastMetrics = [];
    return metrics;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function nameOf(id) {
    return deps.getCore().MEMBERS.find(m => m.id === id)?.name || id;
  }

  function render() {
    const panel = document.getElementById('cast-proposal');
    if (!panel) return;
    const { activeMembers } = deps.getCore();

    if (pending) {
      panel.style.display = 'block';
      panel.className = 'cast-proposal pending';
      document.getElementById('cast-proposal-title').textContent = 'Reading the document…';
      document.getElementById('cast-proposal-names').innerHTML = '';
      document.getElementById('cast-proposal-reason').textContent = 'Asking who this would draw.';
      document.getElementById('cast-proposal-actions').style.display = 'none';
    } else if (proposal) {
      panel.style.display = 'block';
      panel.className = 'cast-proposal';
      document.getElementById('cast-proposal-title').textContent = 'The document would draw';
      document.getElementById('cast-proposal-names').innerHTML = proposal.cast
        .map(
          id =>
            `<span class="cast-proposal-name${proposal.regulars.includes(id) ? ' regular' : ''}">${escape(nameOf(id))}</span>`
        )
        .join('');
      document.getElementById('cast-proposal-reason').textContent =
        proposal.reasoning || 'Your regulars already fill the room tonight.';
      document.getElementById('cast-proposal-actions').style.display = 'flex';
    } else {
      panel.style.display = 'none';
      panel.className = 'cast-proposal'; // don't leave `pending` on a hidden panel
    }

    // The cold-open hint: shown only when the room is genuinely empty and
    // nothing else in this panel is speaking for itself.
    const hint = document.getElementById('members-cast-hint');
    if (hint) hint.style.display = !pending && !proposal && activeMembers.size === 0 ? 'block' : 'none';
  }

  // Names come from the roster, which is user-authored (+ Invite to the
  // Lodge) — escape rather than trust it.
  function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    configure,
    getRegulars,
    isRegular,
    toggleRegular,
    seatRegulars,
    noteHandCast,
    requestProposal,
    acceptProposal,
    dismissProposal,
    consumeMetrics,
    render,
  };
})();
