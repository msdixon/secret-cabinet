'use strict';

// #626 — scenario starters: situations the room is placed in, not texts it
// reads. Where a starter (starters.js) hands the room a library excerpt, a
// scenario hands it something happening now, so the first passage can't be
// taken for a text to critique (SCENARIO_PREAMBLE, server-side) and the two
// ways a guest can step into the room — the You token and "Bring an
// artifact" — have a reason to be opened.
//
// Scenarios with no setup convene on click, like starters. Ones that name a
// setup stage it instead — seat the cast, open the You card or the artifact
// panel, pre-filled — and wait for the guest to press Convene, because the
// point is that they get to do the thing first.
//
// Same script-tag/IIFE convention as starters.js; app.js is touched only for
// the deps bag and one line in convene()'s request body (#632).
window.Scenarios = (function () {
  let deps = null;
  let stagedText = null; // the entry text a scenario put in the paste box

  const MAX_CAST = 3;

  function configure(injectedDeps) {
    deps = injectedDeps;
  }

  // 'scenario' only while the provocation is still exactly what a scenario
  // put there: edit it, or pick a library entry, and it's a document again.
  function occasion() {
    return stagedText !== null && deps && deps.getEntry() === stagedText ? 'scenario' : undefined;
  }

  function seat(cast) {
    const { activeMembers, MEMBERS } = deps.getCore();
    const known = new Set(MEMBERS.map(m => m.id));
    const seated = (cast || []).filter(id => known.has(id)).slice(0, MAX_CAST);
    if (seated.length < 2) return false;
    activeMembers.clear();
    seated.forEach(id => activeMembers.add(id));
    // A deliberate cast: stops the auto-proposal a landing document would trigger.
    deps.noteHandCast();
    deps.renderMembers();
    return true;
  }

  function stageYou() {
    const mode = document.getElementById('play-as-mode-select');
    if (!mode) return;
    mode.value = 'custom';
    deps.handlePlayAsModeChange();
    document.getElementById('playeras-panel')?.classList.add('expanded');
    document.getElementById('play-as-custom-name')?.focus();
    deps.setStatus('The room is seated. Say who you are in it, then convene.', false);
  }

  function stageArtifact(artifact) {
    const text = document.getElementById('artifact-text');
    const member = document.getElementById('artifact-member');
    if (!text || !member) return;
    text.value = artifact.text;
    member.value = artifact.memberId;
    document.getElementById('artifact-panel')?.setAttribute('open', '');
    deps.setStatus('Something has been put on the table. Convene when you are ready.', false);
  }

  let busy = false;

  async function conveneScenario(scenario) {
    if (busy) return;
    if (!seat(scenario.cast)) {
      deps.setStatus('That room could not be assembled — pick another scenario.', false);
      return;
    }
    busy = true;
    try {
      deps.setPastedEntry(scenario.text);
      stagedText = deps.getEntry();
      if (scenario.setup === 'you') return stageYou();
      if (scenario.setup === 'artifact' && scenario.artifact) return stageArtifact(scenario.artifact);
      await deps.convene();
    } finally {
      busy = false;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderCard(scenario, nameOf) {
    const card = el('button', 'starter-card');
    card.type = 'button';
    card.appendChild(el('span', 'starter-hook', scenario.label));
    card.appendChild(el('span', 'scenario-text', scenario.text));
    card.appendChild(el('span', 'starter-cast', scenario.cast.map(nameOf).join(' · ')));
    card.addEventListener('click', () => conveneScenario(scenario));
    return card;
  }

  async function render() {
    const root = document.getElementById('scenarios');
    if (!root) return;
    let data;
    try {
      const res = await fetch('/api/starters');
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return;
    }
    const scenarios = Array.isArray(data?.scenarios) ? data.scenarios : [];
    if (!scenarios.length) return;

    const { MEMBERS } = deps.getCore();
    const nameOf = id => MEMBERS.find(m => m.id === id)?.name || id;

    root.innerHTML = '';
    root.appendChild(el('div', 'starters-heading', 'Or step into a situation'));
    const list = el('div', 'starters-list');
    scenarios.forEach(s => list.appendChild(renderCard(s, nameOf)));
    root.appendChild(list);
  }

  return { configure, render, occasion, conveneScenario };
})();
