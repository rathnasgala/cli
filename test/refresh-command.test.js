import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refreshEngagementSnapshot } from '../src/refresh-command.js';

const SITE_ID = '01K00000000000000000000000';
const ARTICLE_ID = '01K00000000000000000000001';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-refresh-'));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  id: ${SITE_ID}
`);
  return root;
}

test('refresh authenticates as the author, atomically writes, and commits only the snapshot', async () => {
  const root = await fixture();
  const commits = [];
  const snapshot = {
    schemaVersion: 1,
    refreshedAt: '2026-08-14T01:02:03Z',
    articles: { [ARTICLE_ID]: { reactions: 3, comments: 2, views: 10 } }
  };
  const result = await refreshEngagementSnapshot({
    root,
    readCredential: async () => ({
      apiBaseUrl: 'https://api.gala67.com/', accessToken: 'author-token'
    }),
    fetchImpl: async (url, request) => {
      assert.equal(String(url), `https://api.gala67.com/v1/sites/${SITE_ID}/engagement-snapshot`);
      assert.equal(request.headers.Authorization, 'Bearer author-token');
      return new Response(JSON.stringify(snapshot), { status: 200 });
    },
    commitSnapshot: async (commitRoot, relativePath) => commits.push({ commitRoot, relativePath })
  });

  assert.equal(result.changed, true);
  assert.deepEqual(commits, [{ commitRoot: root, relativePath: '.engagement-snapshot.json' }]);
  assert.equal(
    await readFile(path.join(root, '.engagement-snapshot.json'), 'utf8'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
});

test('refresh preserves the previous snapshot when the API fails and skips unchanged commits', async () => {
  const root = await fixture();
  const snapshot = { schemaVersion: 1, refreshedAt: '2026-08-14T01:02:03Z', articles: {} };
  await writeFile(path.join(root, '.engagement-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  let commits = 0;
  const common = {
    root,
    readCredential: async () => ({ apiBaseUrl: 'https://api.gala67.com/', accessToken: 'token' }),
    commitSnapshot: async () => { commits += 1; }
  };

  const unchanged = await refreshEngagementSnapshot({
    ...common,
    fetchImpl: async () => new Response(JSON.stringify(snapshot), { status: 200 })
  });
  assert.equal(unchanged.changed, false);
  assert.equal(commits, 0);

  await assert.rejects(
    () => refreshEngagementSnapshot({
      ...common,
      fetchImpl: async () => new Response('{"message":"unavailable"}', { status: 503 })
    }),
    /HTTP 503/
  );
  assert.equal(
    await readFile(path.join(root, '.engagement-snapshot.json'), 'utf8'),
    `${JSON.stringify(snapshot, null, 2)}\n`
  );
});
