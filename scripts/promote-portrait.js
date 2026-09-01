'use strict';

// #435 — promotes one reviewed portrait candidate to canonical.
//
// POST /api/members (src/routes/member.js) generates a real portrait
// candidate via the Gemini API when GEMINI_API_KEY is set, but deliberately
// stops short of placing it: STYLE_GUIDE.md's own Process treats human
// validation as load-bearing, not a step to automate away. This script is
// that human-reviewed last step, run only after you've looked at the
// candidate and decided it's good — it does not itself judge quality.
//
// Usage:
//   node scripts/promote-portrait.js <id>
//   node scripts/promote-portrait.js <id> --force   (overwrite an existing portrait)
//
// What it does:
//   1. Resizes public/portraits/candidates/<id>.png to 512px on the long
//      edge (matching every prior batch's convention) via macOS's `sips` —
//      this script is a local dev-machine tool, never run on the deployed
//      server, so a macOS-only dependency is fine here (unlike anything in
//      src/, which needs to run on Railway's Linux containers too).
//   2. Writes the result to public/portraits/<id>.png.
//   3. Deletes the candidate file and its entry in PENDING-PROMPTS.md.
//   4. Reminds you to add the STYLE_GUIDE.md Changelog line yourself — that
//      needs an actual look at the image against the register, same as
//      every prior batch; this script doesn't write it for you.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORTRAITS_DIR = path.join(ROOT, 'public', 'portraits');
const CANDIDATES_DIR = path.join(PORTRAITS_DIR, 'candidates');
const PENDING_PROMPTS_FILE = path.join(PORTRAITS_DIR, 'PENDING-PROMPTS.md');

// Matches exactly how appendPendingPortraitPrompt (src/routes/member.js)
// writes entries: header/entry text, each followed by "\n\n---\n\n". The
// leading intro block never contains an "(`id`)" marker, so it's never a
// candidate for removal here.
const ENTRY_SEPARATOR = '\n\n---\n\n';

function removePendingEntry(id) {
  if (!fs.existsSync(PENDING_PROMPTS_FILE)) return false;
  const text = fs.readFileSync(PENDING_PROMPTS_FILE, 'utf8');
  const blocks = text.split(ENTRY_SEPARATOR);
  const idMarker = `(\`${id}\`)`;
  const kept = blocks.filter(block => !block.includes(idMarker));
  if (kept.length === blocks.length) return false;
  fs.writeFileSync(PENDING_PROMPTS_FILE, kept.join(ENTRY_SEPARATOR), 'utf8');
  return true;
}

function main() {
  const [id, ...flags] = process.argv.slice(2);
  const force = flags.includes('--force');

  if (!id) {
    console.error('Usage: node scripts/promote-portrait.js <id> [--force]');
    process.exit(1);
  }

  const candidatePath = path.join(CANDIDATES_DIR, `${id}.png`);
  if (!fs.existsSync(candidatePath)) {
    console.error(`No candidate found at public/portraits/candidates/${id}.png`);
    process.exit(1);
  }

  const canonicalPath = path.join(PORTRAITS_DIR, `${id}.png`);
  if (fs.existsSync(canonicalPath) && !force) {
    console.error(`public/portraits/${id}.png already exists. Re-run with --force to overwrite it.`);
    process.exit(1);
  }

  if (process.platform !== 'darwin') {
    console.error("This script shells out to macOS's `sips` for resizing and only runs on macOS.");
    process.exit(1);
  }

  execFileSync('sips', ['-Z', '512', candidatePath, '--out', canonicalPath], { stdio: 'inherit' });
  fs.rmSync(candidatePath);
  const removedFromPending = removePendingEntry(id);

  console.log(`\nPromoted public/portraits/candidates/${id}.png -> public/portraits/${id}.png`);
  console.log(
    removedFromPending
      ? `Removed its entry from PENDING-PROMPTS.md.`
      : `No matching entry found in PENDING-PROMPTS.md (nothing removed).`
  );
  console.log(
    `\nRemaining manual step: add a line to STYLE_GUIDE.md's Changelog noting what you checked — this needs an actual look at the image against the register, same as every prior batch.`
  );
}

main();
