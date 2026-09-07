'use strict';

// #193 route-extraction seam-map, module 4 of 7 — member/roster routes:
// listing, dossier lookup, and drafting a brand-new character file. Touches
// `roster` (the live array — mutated in place via push, same reference
// server.js and every other route module shares) and writes
// `rosterFile`/a new member .md file, but no session or streaming state.

const fs = require('fs');
const path = require('path');
const portraitGeneration = require('../portrait-generation');

function registerMemberRoutes(
  app,
  {
    roster,
    rosterModule,
    loadMemberFile,
    membersDir,
    rosterFile,
    client,
    model,
    lodgeContext,
    axesDoc,
    portraitStyleGuide,
    portraitPromptExemplar,
    pendingPortraitPromptsFile,
    geminiApiKey,
    portraitCandidatesDir,
    likenessRefsDir = null,
    generatePortraitImage = portraitGeneration.generatePortraitImage,
  }
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
        // #436: adaptive thinking (on by default for claude-sonnet-5 when
        // `thinking` is omitted) can consume nearly this entire budget
        // against the real production system prompt (~42K chars of
        // exemplars + AXES.md + lodge-context.md) and never emit a text
        // block at all -- confirmed by direct reproduction. Disabled
        // outright, same fix #406 applied to the two tool-only calls in
        // pipeline-director.js/pipeline-disposition.js; a second
        // reproduction with a short paraphrased prompt produced a full text
        // response using under 10% of the budget, so there's no evidence
        // this drafting task's quality depends on adaptive reasoning.
        thinking: { type: 'disabled' },
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const characterFile = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // #436: defense in depth even with thinking disabled -- treat empty
      // generation as a failure rather than silently writing a 0-byte
      // character file and pushing a broken member into the roster.
      if (!characterFile.trim()) {
        console.error('Member creation error: character-file generation produced no text content', {
          stopReason: response.stop_reason,
        });
        return res.status(500).json({ error: 'Failed to draft character file' });
      }

      fs.writeFileSync(filePath, characterFile, 'utf8');

      const newMember = { id, name: name.trim(), file, glyph: rosterModule.assignGlyph(roster) };
      roster.push(newMember);
      fs.writeFileSync(rosterFile, JSON.stringify(roster, null, 2), 'utf8');

      // #259/#435 — draft a portrait-generation prompt at the same time the
      // member is added, per STYLE_GUIDE.md's Process step 4, and (if a
      // Gemini API key is configured) generate a real candidate image from
      // it via the Gemini API directly (#435 spike, 2026-08-25: confirmed
      // server-callable, no agent session needed). Both steps are
      // independently best-effort -- a failure in either shouldn't take
      // down member creation, which is the primary thing this endpoint
      // does. The candidate lands in portraitCandidatesDir, never the
      // canonical public/portraits/<id>.png path -- promotion (resize,
      // place, changelog) stays a deliberate, human-reviewed step per
      // STYLE_GUIDE.md's own human-validation requirement (see
      // scripts/promote-portrait.js). #450 extends this same best-effort
      // block to also draft the #449-decided reaction set (happy/thinking/
      // angry) once the baseline candidate exists, gated behind the same
      // promotion script.
      let portraitPrompt = null;
      let portraitPromptText = null;
      try {
        const drafted = await draftPortraitPrompt({
          client,
          model,
          name: name.trim(),
          bio,
          portraitStyleGuide,
          portraitPromptExemplar,
        });
        portraitPrompt = drafted.entry;
        portraitPromptText = drafted.promptText;
        appendPendingPortraitPrompt(pendingPortraitPromptsFile, portraitPrompt);
      } catch (err) {
        console.error('Portrait prompt drafting error (member creation still succeeded):', err);
      }

      let portraitCandidatePath = null;
      const reactionCandidatePaths = {};
      if (geminiApiKey && portraitPromptText) {
        try {
          // #541 — if a plain archival likeness photo has already been sourced
          // for this member (public/portraits/likeness-refs/<id>.*, per that
          // directory's metadata.json), anchor the base-portrait generation to
          // it via referenceImages instead of relying on the drafted prompt's
          // prose alone — the same gap that let Crowley's base portrait drift
          // toward a young, over-romanticized likeness with no verified source
          // to correct it. No sourced reference is the common case for a
          // brand-new member (sourcing one isn't something this endpoint can
          // do unattended), so this is opportunistic: falls back to the prior
          // text-only behavior when nothing is found.
          const likenessRefPath = findLikenessReference(likenessRefsDir, id);
          const basePrompt = likenessRefPath
            ? portraitGeneration.buildLikenessAnchoredBasePrompt(portraitPromptText)
            : portraitPromptText;
          const baseReferenceImages = likenessRefPath
            ? [{ mimeType: mimeTypeForImagePath(likenessRefPath), data: fs.readFileSync(likenessRefPath) }]
            : undefined;
          const imageBuffer = await generatePortraitImage({
            apiKey: geminiApiKey,
            prompt: basePrompt,
            ...(baseReferenceImages ? { referenceImages: baseReferenceImages } : {}),
          });
          fs.mkdirSync(portraitCandidatesDir, { recursive: true });
          fs.writeFileSync(path.join(portraitCandidatesDir, `${id}.png`), imageBuffer);
          portraitCandidatePath = `public/portraits/candidates/${id}.png`;

          // #450 — draft the decided reaction set (happy/thinking/angry,
          // per #449) alongside the baseline, same best-effort/non-fatal
          // treatment as the baseline candidate above. Anchored on the
          // baseline candidate buffer just generated (not yet promoted, so
          // there's no public/portraits/<id>.png to read yet) via
          // referenceImages, same reference-image approach batch 2/3 landed
          // on for the existing-roster backfill. Each reaction candidate
          // lands at public/portraits/candidates/<id>-<reaction>.png,
          // promotable with the existing `node scripts/promote-portrait.js
          // <id>-<reaction>` (it already treats its id argument as opaque).
          for (const reaction of portraitGeneration.REACTION_TYPES) {
            try {
              const reactionBuffer = await generatePortraitImage({
                apiKey: geminiApiKey,
                prompt: portraitGeneration.buildReactionPrompt(reaction, id),
                referenceImages: [{ mimeType: 'image/png', data: imageBuffer }],
              });
              const reactionId = `${id}-${reaction}`;
              fs.writeFileSync(path.join(portraitCandidatesDir, `${reactionId}.png`), reactionBuffer);
              reactionCandidatePaths[reaction] = `public/portraits/candidates/${reactionId}.png`;
            } catch (err) {
              console.error(
                `Reaction portrait generation error for "${reaction}" (member creation still succeeded):`,
                err
              );
            }
          }
        } catch (err) {
          console.error('Portrait image generation error (member creation still succeeded):', err);
        }
      }

      res.json({ member: newMember, characterFile, portraitPrompt, portraitCandidatePath, reactionCandidatePaths });
    } catch (err) {
      console.error('Member creation error:', err);
      res.status(500).json({ error: 'Failed to draft character file' });
    }
  });
}

// #259/#435 — draft one portrait-generation prompt entry, matching the
// format of public/portraits/WAVE-4-PROMPTS.md, against the rules in
// public/portraits/STYLE_GUIDE.md. Same exemplar-based pattern as the
// character-file system prompt above, scaled down to a single short entry.
// Reasoning is organized around Rachel's own established template (used by
// hand across prior waves via Nano Banana/Gemini) rather than an invented
// structure. Returns { entry, promptText }: `entry` is the full heading +
// paragraph for PENDING-PROMPTS.md/manual pasting; `promptText` is just the
// paragraph, for feeding directly to generatePortraitImage.
async function draftPortraitPrompt({ client, model, name, bio, portraitStyleGuide, portraitPromptExemplar }) {
  const systemPrompt = `You are drafting a single portrait-generation prompt entry for a member just added to The Secret-Cabin-et's historical salon roster.

Reason through this established template (Rachel's own, used by hand across every prior portrait wave) to work out the content, then write the final prompt:
- Subject: (who, with any concrete distinguishing detail)
- Style: warm etching-adjacent portrait
- Composition: head-and-shoulders, historically accurate attire, authentic material textures
- Lighting / Mood: natural directional lighting, contemplative expression, minimal background distraction

Two rules override that template and are NON-NEGOTIABLE regardless of what it alone would produce — a real test generation showed the template's own "minimal background distraction" phrasing is not strict enough on its own and let a bookshelf leak into the background:
- **State portrait orientation explicitly in the prompt text** (taller than wide) — don't let it default to square or landscape.
- **State a plain, dark, unornamented background explicitly and strongly — no scene elements at all**: no furniture, no bookshelves, no architectural detail, nothing beyond what the subject holds or wears. Not "minimal distraction" — actually absent.

Also follow STYLE_GUIDE.md's remaining rules (full text below): limited warm sepia/candlelit palette, visible linework/texture rather than photorealistic or cartoon/flat-vector rendering.

Output ONLY one entry, matching the exemplar sheet's shape exactly: one heading line ("## Name (\`id\`) — dates — likeness tier"), a blank line, then one paragraph of ready-to-paste prompt text — nothing else, no surrounding commentary, no markdown fencing, no separate "visual breakdown" section.

Pick the correct likeness tier per the guide's "Known-vs-unknown likeness" section:
- Photographed — recognizable likeness against surviving photographs.
- Character study (known painted/engraved likeness) — a well-known contemporary portrait survives; use it as a loose likeness anchor, not a direct reproduction.
- Character study — no photographic or contemporary likeness reference exists; render as a period-appropriate character study, not a likeness reproduction. For figures with an existing devotional/iconographic tradition, favor a secular character-study framing over reproducing religious iconography.

If you're not confident which tier applies, say so in the heading and default to the plain "Character study" tier rather than inventing a likeness anchor that may not exist.

Include one concrete visual distinguishing detail specific to this person's real, documented life or trade — not a generic addition — the way the exemplars use Böhme's cobbler's awl or Paracelsus's sword hilt. Don't invent biographical facts not supported by the biography given.

STYLE_GUIDE.md:
${portraitStyleGuide}

FORMAT EXEMPLAR (WAVE-4-PROMPTS.md — match this heading/paragraph shape, one entry only):
${portraitPromptExemplar}`;

  const userMessage = `Draft one portrait-generation prompt entry for: ${name}

Biography / background (same text used for this member's character file):
${bio}`;

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    // Same #406/#436 failure mode as the character-file call above (adaptive
    // thinking silently consuming the whole budget with no text block) —
    // found while verifying #450: this call's small 700-token budget hit it
    // too, and its empty result short-circuits the `portraitPromptText`
    // check downstream, silently skipping both baseline and reaction image
    // generation with no error logged.
    thinking: { type: 'disabled' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  const blankLineIdx = raw.indexOf('\n\n');
  return blankLineIdx === -1
    ? { entry: raw, promptText: raw }
    : { entry: raw, promptText: raw.slice(blankLineIdx + 2).trim() };
}

// #259 — append one drafted entry to the running pending-prompts log,
// writing the header only on first use. A human (or a future session)
// clears an entry once its image is generated and placed, same lifecycle
// as STYLE_GUIDE.md's own Process describes.
function appendPendingPortraitPrompt(pendingPortraitPromptsFile, portraitPrompt) {
  const header = fs.existsSync(pendingPortraitPromptsFile)
    ? ''
    : `# Pending Portrait Prompts\n\nAuto-drafted, one entry per member added via the in-app "Add Member" flow ([#259](https://github.com/msdixon/secret-cabinet/issues/259)) — ready to paste into whatever image-generation tool is currently in use (Nano Banana, as of this writing), same convention as [BATCH-1-PROMPTS.md](BATCH-1-PROMPTS.md) and [WAVE-4-PROMPTS.md](WAVE-4-PROMPTS.md). Once an entry's image is generated, resized to 512px on the long edge, and placed at \`public/portraits/<id>.png\` per [STYLE_GUIDE.md](STYLE_GUIDE.md)'s Process, delete the entry here and log the placement in STYLE_GUIDE.md's Changelog, same as every prior batch.\n\n---\n\n`;
  fs.appendFileSync(pendingPortraitPromptsFile, `${header}${portraitPrompt}\n\n---\n\n`, 'utf8');
}

// #541 — looks for a sourced likeness reference photo at
// <likenessRefsDir>/<id>.{jpg,jpeg,png}. Returns its path, or null if
// likenessRefsDir wasn't configured or no matching file exists (the common
// case — sourcing a reference is a manual step, not something this endpoint
// does on its own).
const LIKENESS_REF_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

function findLikenessReference(likenessRefsDir, id) {
  if (!likenessRefsDir) return null;
  for (const ext of LIKENESS_REF_EXTENSIONS) {
    const candidate = path.join(likenessRefsDir, `${id}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mimeTypeForImagePath(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  return ext === '.png' ? 'image/png' : 'image/jpeg';
}

module.exports = { registerMemberRoutes };
