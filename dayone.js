'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const DAYONE_CMD = '/usr/local/bin/dayone';

async function withDayOne(fn) {
  const transport = new StdioClientTransport({ command: DAYONE_CMD, args: ['mcp'] });
  const client = new Client({ name: 'secret-cabinet', version: '1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function listJournals() {
  return withDayOne(async (client) => {
    const result = await client.callTool({ name: 'list_journals', arguments: {} });
    const text = result.content.find(c => c.type === 'text')?.text || '[]';
    return JSON.parse(text);
  });
}

async function getLatestEntry(journalId) {
  const entries = await getRecentEntries(journalId, 1);
  return entries[0] || null;
}

async function getRecentEntries(journalId, limit = 3) {
  return withDayOne(async (client) => {
    // Fetch extra so filtering 'generated' still yields `limit` results
    const result = await client.callTool({
      name: 'get_entries',
      arguments: { journal_ids: [journalId], limit: limit + 8 },
    });
    const text = result.content.find(c => c.type === 'text')?.text || '[]';
    const entries = JSON.parse(text);
    return entries
      .filter(e => !(Array.isArray(e.tags) && e.tags.includes('generated')))
      .slice(0, limit);
  });
}

async function createEntry(journalId, markdown, tags = []) {
  return withDayOne(async (client) => {
    const result = await client.callTool({
      name: 'create_entry',
      arguments: {
        journal_id: journalId,
        text: markdown,
        tags: tags.join(','),
      },
    });
    const raw = result.content.find(c => c.type === 'text')?.text || '{}';
    return JSON.parse(raw);
  });
}

module.exports = { listJournals, getLatestEntry, getRecentEntries, createEntry };
