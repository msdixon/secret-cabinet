'use strict';

// #268 — relationship-as-data layer for member interactions.
//
// Decided on the issue (2026-08-17): seed/source is the existing knowledge
// graph (#22/#84, src/graph.js), not a new hand-authored structure. The
// prose/data split from #197 stays: pairs a member's own character file
// already narrates in its "YOUR RELATIONSHIPS IN THIS ROOM" section (the
// craft-quality writing — e.g. crowley.md's Waite-needling) are left
// untouched; only pairs that section is silent on fall back to this
// thinner, graph-assembled note, composed per-evening for whoever's
// actually present.
//
// Field-shape decision (the open question the issue asked this pass to
// resolve): reuse the graph edge shape as-is — {source, target, type,
// label, origin, weight, sessions?} — rather than inventing new
// register/tension/affinity/shared-history fields. `type` already sorts
// edges into a register (REGISTER_BY_TYPE below maps it to a tone
// fragment), and `label` already IS the shared-history pointer, written at
// prose-fragment length by whoever added the seed edge. Adding parallel
// fields would just be two places to keep the same fact in sync, which is
// the "new structure from scratch" the decision comment ruled out.
//
// #51's per-speaker architecture (pipeline-speaker.js) means only the
// current speaker's own file ever reaches their system prompt — another
// present member's file, and whatever it says about this speaker, never
// does. So "already covered by prose" only ever needs to check the current
// speaker's own file, never both directions of a pair.

const RELATIONSHIPS_HEADING = '## YOUR RELATIONSHIPS IN THIS ROOM';

const REGISTER_BY_TYPE = {
  rivalry: 'an open friction between you, on the record',
  love: 'an entanglement between you, on the record',
  collaboration: 'a real collaboration between you, on the record',
  'intellectual-debt': 'a debt one of you owes the other, on the record',
  parallel: 'an unclaimed kinship between your work, on the record',
  influence: 'a documented line of influence between you',
  membership: 'a shared institutional history',
  'co-convened': 'a room you have shared before',
};

// Isolates the member file's own relationships section so a name match
// can't accidentally fire on some unrelated mention elsewhere in the file
// (e.g. a member discussed in the "WHAT YOU DO WITH THE DOCUMENT" section).
function relationshipsSectionOf(memberFileText) {
  const startIdx = memberFileText.indexOf(RELATIONSHIPS_HEADING);
  if (startIdx === -1) return '';
  const rest = memberFileText.slice(startIdx + RELATIONSHIPS_HEADING.length);
  const nextHeadingIdx = rest.indexOf('\n## ');
  return nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
}

// Substring match against the other member's display name and any
// aliases. Not foolproof against every hand-authored formatting variant
// (full honorifics, mid-sentence-only mentions), but names in this room are
// distinctive enough that false positives are rare — and a missed prose
// mention just costs a redundant data line, not a suppressed one, which is
// the safer failure mode here.
function mentionsMember(sectionText, otherMember) {
  const candidates = [otherMember.name, ...(otherMember.aliases || [])].filter(Boolean);
  return candidates.some(name => sectionText.includes(name));
}

function edgesForPair(allEdges, aId, bId) {
  return (allEdges || []).filter(
    e => (e.source === aId && e.target === bId) || (e.source === bId && e.target === aId)
  );
}

function renderEdge(edge, otherName) {
  const register = REGISTER_BY_TYPE[edge.type] || 'a documented connection';
  if (edge.type === 'co-convened') {
    const n = edge.weight || 1;
    return `**${otherName}**: ${register} — ${n} session${n === 1 ? '' : 's'} together so far. No hand-authored history beyond that; play it by instinct.`;
  }
  return `**${otherName}**: ${register} — ${edge.label}.`;
}

// Builds the assembled fallback for one speaker: for every other present
// member their own file's relationships section doesn't already cover,
// render whatever the graph knows about that pair. Silent for a pair with
// neither prose nor graph data — the room improvises rather than being
// handed a fabricated connection.
function buildRelationshipLines(memberFileText, member, otherPresentMembers, allEdges) {
  const section = relationshipsSectionOf(memberFileText);
  const lines = [];
  (otherPresentMembers || []).forEach(other => {
    if (!other || other.id === member.id) return;
    if (mentionsMember(section, other)) return;
    edgesForPair(allEdges, member.id, other.id).forEach(edge => lines.push(renderEdge(edge, other.name)));
  });
  return lines;
}

function buildRelationshipSection(memberFileText, member, otherPresentMembers, allEdges) {
  const lines = buildRelationshipLines(memberFileText, member, otherPresentMembers, allEdges);
  if (!lines.length) return '';
  return `\n\n---\n\n## OTHERS IN THE ROOM TONIGHT, PER THE ROOM'S RECORD\n\nThin, assembled notes — not written for you, not in your own voice. Where your own account above is silent on someone present tonight, this is what the record shows:\n\n${lines.join(
    '\n'
  )}`;
}

module.exports = {
  REGISTER_BY_TYPE,
  relationshipsSectionOf,
  mentionsMember,
  edgesForPair,
  renderEdge,
  buildRelationshipLines,
  buildRelationshipSection,
};
