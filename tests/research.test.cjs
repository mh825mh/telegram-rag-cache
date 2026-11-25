const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-research-test-'));
const dataDir = path.join(home, '.lmstudio', 'plugin-data', 'telegram-rag-cache');
fs.mkdirSync(dataDir, { recursive: true });
const originalHomedir = os.homedir;
os.homedir = () => home;
const provider = require('../dist/toolsProvider.js');
os.homedir = originalHomedir;
const timestamp = Date.parse('2026-11-01T12:00:00Z');
const updated = Date.parse('2026-11-03T12:00:00Z');
const file = path.join(dataDir, 'cache_example.json');
const cache = {
  channel: 'example', lastUpdated: updated, earliestId: 1, latestId: 2,
  messages: [
    { id: 1, channel: 'example', text: 'Research about open models', timestamp, date: '2026-11-01T12:00:00Z' },
    { id: 2, channel: 'example', text: 'Another open model\n' + 'x'.repeat(1600), timestamp: timestamp + 1000, date: '2026-11-01T12:00:01Z' },
  ],
};
fs.writeFileSync(file, JSON.stringify(cache));
const tools = provider.toolsProvider({});
async function call(name, args = {}) {
  const t = (await tools).find((candidate) => candidate.name === name);
  assert.ok(t, `missing ${name}`);
  t.checkParameters(args);
  return t.implementation(args);
}
test.after(() => {
  assert.equal(path.dirname(home), os.tmpdir());
  assert.ok(path.basename(home).startsWith('telegram-research-test-'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('research contract reports freshness and returns ranked stable links', async () => {
  const info = await call('cache_info');
  assert.equal(info.contractVersion, '1.0');
  assert.equal(info.itemCount, 2);
  assert.equal(info.latestCachedAt, '2026-11-03T12:00:00.000Z');
  const result = await call('search_cache', { query: 'research', source: '@Example', limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].itemId, 'example/1');
  assert.equal(result.results[0].pluginId, 'mh825/telegram-rag-cache');
  assert.equal(result.results[0].sourceUrl, 'https://t.me/example/1');
  assert.equal(result.results[0].publishedAt, '2026-11-01T12:00:00.000Z');
  assert.equal((await call('search_cache', { query: 'research', since: '2026-11-02T00:00:00Z' })).results.length, 0);
  assert.equal((await call('search_cache', { query: 'research', source: 'other' })).results.length, 0);
});

test('item lookup bounds content and validates inputs', async () => {
  const result = await call('get_cached_item', { itemId: 'example/2' });
  assert.ok(result.item.excerpt.length <= 1201);
  assert.equal(result.item.sourceUrl, 'https://t.me/example/2');
  assert.equal((await call('get_cached_item', { itemId: 'example/999' })).item, null);
  await assert.rejects(call('get_cached_item', { itemId: '../bad/1' }));
  await assert.rejects(call('search_cache', { query: 'a', limit: 51 }));
  await assert.rejects(call('search_cache', { query: 'a', since: 'invalid' }));
});

test('corrupt cache is reported without modification', async () => {
  fs.writeFileSync(file, '{broken');
  const logs = [];
  const warn = console.warn;
  console.warn = (line) => logs.push(line);
  try {
    await assert.rejects(call('cache_info'), /Invalid cache JSON/);
  } finally {
    console.warn = warn;
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"errorCategory":"invalid_cache"/);
  assert.doesNotMatch(logs[0], /broken|example/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
