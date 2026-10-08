'use strict';

// #637 — the admin hub: one page that links to every admin-side view, so the
// front page needs a single "Admin" link rather than one per metric. Gated by
// auth.js's ADMIN_ROUTES (`/admin(/|$)` already covers it), checked before the
// public app-shell tier, so no new auth work lives here.
//
// Static on purpose for v1: a new admin view is one entry in ADMIN_LINKS, not
// a front-page change. Later entries (readable renderings of the markdown
// endpoints, #625's funnel) slot in the same way.

const { gatePageHtml } = require('../auth');

const ADMIN_LINKS = [
  {
    href: '/admin/users',
    title: 'Guest list',
    note: 'Who can sign in, last sign-in, and month-to-date Anthropic and voice spend per guest (#594, #624).',
  },
  {
    href: '/api/admin/visits',
    title: 'Visits',
    note: 'Public-tier and signed-in traffic report (markdown, #422).',
  },
  {
    href: '/api/admin/sessions',
    title: 'Sessions',
    note: 'Every session’s owner, timestamps and error state — metadata only, never content (JSON, #595).',
  },
  {
    href: '/api/admin/bibliography',
    title: 'Bibliography',
    note: 'Project-wide works-cited across all sessions (markdown, #356).',
  },
  {
    href: '/api/admin/citation-manifest',
    title: 'Citation manifest',
    note: 'Citation check-in for manual promotion (markdown, #153).',
  },
];

function adminHubHtml(links = ADMIN_LINKS) {
  const items = links.map(l => `      <li><a href="${l.href}">${l.title}</a><span>${l.note}</span></li>`).join('\n');
  return gatePageHtml(
    `    <style>
      ul.hub { list-style: none; text-align: left; margin-bottom: 2rem; }
      ul.hub li { padding: .75rem 0; border-bottom: 1px solid #3a3228; }
      ul.hub a { color: #c8b89a; }
      ul.hub span { display: block; font-size: .8rem; color: #8b7355; margin-top: .25rem; line-height: 1.4; }
    </style>
    <p class="note">Admin: every view only you can see.</p>
    <ul class="hub">
${items}
    </ul>
    <p class="alt"><a href="/">Back to the lodge</a></p>`,
    { width: 560 }
  );
}

function registerAdminHubRoutes(app) {
  app.get('/admin', (req, res) => {
    res.send(adminHubHtml());
  });
}

module.exports = { registerAdminHubRoutes, adminHubHtml, ADMIN_LINKS };
