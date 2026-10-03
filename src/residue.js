// #595: residue (a member's per-user drift between meetings) is keyed per
// user. The flat residue/<member>.json files predate that; with a passphrase
// configured they move into the admin's directory, matching the rule that
// pre-existing data goes to Rachel. Idempotent: never overwrites a file that
// already exists at the destination, and a second run finds nothing to move.
const fs = require('fs');
const path = require('path');

function claimLegacyResidue(residueDir, adminDir) {
  let moved = 0;
  let entries;
  try {
    entries = fs.readdirSync(residueDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const dest = path.join(adminDir, entry.name);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(adminDir, { recursive: true });
    fs.renameSync(path.join(residueDir, entry.name), dest);
    moved++;
  }
  return moved;
}

module.exports = { claimLegacyResidue };
