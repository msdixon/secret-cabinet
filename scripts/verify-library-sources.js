'use strict';

// Verifies that every prompts/library/*.md entry's source_url actually
// resolves to real content, rather than being a plausible-looking but
// invented identifier. Filed as #157: sourcing images for #30 found that
// 6 of the original 10 hand-curated entries had fabricated archive.org
// identifiers that 404 — exactly the links /verify-citations (#36) presents
// to users as "grounded in" provenance, never previously checked.
// No test framework exists in this repo — matches its existing ad hoc
// script style (see scripts/test-director.js). Run with:
//   node scripts/verify-library-sources.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIBRARY_DIR = path.join(ROOT, 'prompts', 'library');

function extractFrontmatter(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  return {
    id: fm.match(/^id:\s*(.*)$/m)?.[1]?.trim(),
    source_url: fm.match(/^source_url:\s*"?(.*?)"?$/m)?.[1] || '',
  };
}

// archive.org's /details/<id> pages 200 even for nonexistent identifiers in
// some cases, but /metadata/<id> reliably returns {} for a made-up one —
// that's the check that actually caught #157's fabricated identifiers.
async function checkArchiveOrg(identifier) {
  const res = await fetch(`https://archive.org/metadata/${identifier}`);
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const data = await res.json();
  if (!data || Object.keys(data).length === 0) return { ok: false, reason: 'no such archive.org item' };
  return { ok: true };
}

// Same failure mode as archive.org, different door: a doi.org link 404s
// cleanly for a made-up DOI, but a *plausible but wrong* one can resolve to
// some unrelated real work and still pass a plain HTTP check. Crossref's
// API is the equivalent of archive.org's /metadata — it's what #35's
// license section relies on to make a DOI actually checkable, not just
// reachable.
async function checkDoi(doi) {
  const res = await fetch(`https://api.crossref.org/works/${doi}`);
  if (!res.ok) return { ok: false, reason: `no such DOI (Crossref HTTP ${res.status})` };
  const data = await res.json();
  if (!data?.message?.title) return { ok: false, reason: 'DOI resolved but Crossref has no title for it' };
  return { ok: true };
}

async function checkGeneric(url) {
  try {
    const res = await fetch(url);
    return res.ok ? { ok: true } : { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function verifyOne(source_url) {
  const archiveMatch = source_url.match(/^https:\/\/archive\.org\/details\/(.+)$/);
  if (archiveMatch) return checkArchiveOrg(archiveMatch[1]);
  const doiMatch = source_url.match(/^https:\/\/doi\.org\/(.+)$/);
  if (doiMatch) return checkDoi(doiMatch[1]);
  return checkGeneric(source_url);
}

async function main() {
  const files = fs
    .readdirSync(LIBRARY_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
  const results = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf8');
    const { id, source_url } = extractFrontmatter(raw);
    if (!id) continue; // not a library entry (e.g. README.md) — no frontmatter to check
    if (!source_url) {
      results.push({ id: id || file, status: 'MISSING', detail: 'source_url is empty' });
      continue;
    }
    const check = await verifyOne(source_url);
    results.push({
      id: id || file,
      status: check.ok ? 'OK' : 'BROKEN',
      detail: check.ok ? source_url : `${source_url} — ${check.reason}`,
    });
  }

  const broken = results.filter(r => r.status !== 'OK');
  results.forEach(r => console.log(`[${r.status}]`.padEnd(10), r.id.padEnd(38), r.detail));
  console.log(`\n${results.length - broken.length}/${results.length} source_urls verified.`);
  if (broken.length) {
    console.log(`${broken.length} need attention before they're trusted as "grounded in" links.`);
    process.exitCode = 1;
  }
}

main();
