'use strict';

// #193 route-extraction seam-map, module 4 of 7 — member/roster routes:
// listing, dossier lookup, and drafting a brand-new character file. Touches
// `roster` (the live array — mutated in place via push, same reference
// server.js and every other route module shares) and writes
// `rosterFile`/a new member .md file, but no session or streaming state.

const fs = require('fs');
const path = require('path');

function registerMemberRoutes(
  app,
  { roster, rosterModule, loadMemberFile, membersDir, rosterFile, client, model, lodgeContext, axesDoc }
) {
  // GET /api/members — return current roster
  app.get('/api/members', (req, res) => {
    res.json(roster);
  });

  // GET /api/members/:id/dossier — parse and return brief + voice from character file
  app.get('/api/members/:id/dossier', (req, res) => {
    const member = roster.find(m => m.id === req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    const text = loadMemberFile(member.file);
    if (!text) return res.json({ id: member.id, name: member.name, bio: null, voice: null });

    res.json({
      id: member.id,
      name: member.name,
      bio: rosterModule.extractSection(text, 'WHO YOU ARE'),
      voice: rosterModule.extractSection(text, 'HOW YOU SPEAK'),
    });
  });

  // POST /api/members — draft + save a new character file, update roster
  app.post('/api/members', async (req, res) => {
    const { name, bio, voiceRegister, cognitiveStyle, relationships } = req.body;
    if (!name?.trim() || !bio?.trim()) return res.status(400).json({ error: 'name and bio are required' });

    // Build a safe filename + id from the name
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const file = `${id}.md`;
    const filePath = path.join(membersDir, file);

    if (fs.existsSync(filePath)) {
      return res.status(409).json({
        error: `A member file already exists for "${name}". Choose a different name or edit the file directly.`,
      });
    }

    // Two canonical character files as format exemplars — deliberately stylistically
    // different (Crowley baroque/needling, Jung measured/clinical) so the generator
    // learns the *structure* and depth bar, not one character's specific voice.
    const exemplarCrowley = loadMemberFile('crowley.md');
    const exemplarJung = loadMemberFile('jung.md');

    const systemPrompt = `You are a researcher and writer helping build a character prompt for a historical salon simulation called The Secret-Cabin-et. The salon is atemporal — members from different centuries speak together as equals. You will write a character system prompt matching the structure and depth of the two exemplars below — not the specific voice of either one. Crowley is baroque, associative, and needling; Jung is measured and clinical. Neither is the template for tone — the person you're drafting sets their own tone. Read both for how much specificity and depth each section carries, then write to that bar for this character.

The character file must contain these sections, in order:
- # [NAME IN CAPS]
- ### Character System Prompt — the Secret-Cabin-et
- *Builds on: Lodge Context Document*
- ## WHO YOU ARE — 3–4 paragraphs: historical identity, expertise, self-understanding, and at least one honest complicating note — something this person would rather not examine, or (see historical accuracy rule below) a genuinely documented tension in their record
- **Optional bespoke section(s)** — 0–2 additional named sections unique to this person (in the spirit of Crowley's "THE PERSISTENT MINOR ELEMENT" or Jung's "THE SOCIETY, RENAMED" / "THE NEKYIA, IN GENERAL") for a real, specific, documented tension, controversy, or defining relationship the generic sections don't have room for. Only add one if the biography actually supports it — don't invent a section for its own sake, and don't force one if nothing warrants it.
- ## HOW YOU SPEAK — 3–5 paragraphs: register, rhythm, rhetorical moves, what they do with disagreement
- ## YOUR RELATIONSHIPS IN THIS ROOM — one substantive paragraph per relevant member present in the room (use only the members listed in the existing roster: ${roster.map(m => m.name).join(', ')}). Ground each in something specific and real — a shared teacher, a documented meeting or correspondence, a textual influence, a real point of intellectual overlap or conflict — not generic sentiment. **Before writing this section, read INTERPRETIVE LENSES below.** If a relationship echoes a pattern already worked out there, apply the refined framing rather than reinventing it or reintroducing a version that was explicitly rejected.
- ## WHAT YOU DO WITH THE DOCUMENT — 2 paragraphs about how this member engages with a journal entry read aloud
- ## WHAT YOU DO NOT DO — bullet list of 4–6 hard constraints on this character's voice
- *Character prompt complete. Deploy on top of Lodge Context Document.*

Rules:
- Write in second person ("You are…", "You speak…")
- Be specific: cite real texts, real positions, real historical tensions
- Do not invent citations or relationships
- Keep the same section headers and formatting as the exemplars; match tone to the person, not to either exemplar
- Do not summarize or editorialize — write the prompt as if deploying it directly
- **Historical accuracy over authorial gloss (INTERPRETIVE LENSES, Axis 3):** if this person's documented life includes genuinely controversial material — prejudice, cruelty, complicity — represent it accurately and proportionately. Don't omit it for the room's comfort, and don't inflate it into caricature. If you're not confident of the shape or severity of something, don't guess at specifics — write around it rather than fabricate a claim.
- **Register:** per the Lodge Context Document's REGISTER PERMISSIONS (included below), humor and the erotic are available to every member in proportion to their own nature. Don't silently default this character to a flat or humorless register unless that flatness is itself true to who they were.

INTERPRETIVE LENSES — consult before drafting relationships (a writer's reference, not part of the runtime prompt):
${axesDoc}

LODGE CONTEXT — REGISTER PERMISSIONS (for calibrating voice, not to be echoed verbatim):
${lodgeContext.slice(lodgeContext.indexOf('## REGISTER PERMISSIONS'), lodgeContext.indexOf('## FORMAT — ACTIONS AND SPEECH'))}

EXEMPLAR ONE (Crowley — baroque, needling, high-theater):
${exemplarCrowley}

EXEMPLAR TWO (Jung — measured, clinical, a controversy held without a clean verdict):
${exemplarJung}`;

    const userMessage = `Write a character prompt for: ${name}

Biography / background:
${bio}

Voice and register:
${voiceRegister || '(not specified — infer from the biography)'}

Cognitive style:
${cognitiveStyle || '(not specified — infer from the biography)'}

Relationship notes:
${relationships || '(not specified — infer from historical record)'}`;

    try {
      const response = await client.messages.create({
        model,
        max_tokens: 7000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const characterFile = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      fs.writeFileSync(filePath, characterFile, 'utf8');

      const newMember = { id, name: name.trim(), file, glyph: rosterModule.assignGlyph(roster) };
      roster.push(newMember);
      fs.writeFileSync(rosterFile, JSON.stringify(roster, null, 2), 'utf8');

      res.json({ member: newMember, characterFile });
    } catch (err) {
      console.error('Member creation error:', err);
      res.status(500).json({ error: 'Failed to draft character file' });
    }
  });
}

module.exports = { registerMemberRoutes };
