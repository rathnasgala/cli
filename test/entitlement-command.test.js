import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireAttributionEntitlement } from '../src/entitlement-command.js';

const SITE = '01K00000000000000000000010';
const artifact = Object.freeze({
  siteId: SITE, tier: 'PAID', issuedAt: '2026-08-14T00:00:00Z',
  expiresAt: '2026-09-14T00:00:00Z', keyId: 'attribution-v1', signature: 'signature'
});

test('writes and commits the exact server artifact once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-entitlement-command-'));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1\nsite:\n  id: ${SITE}\n`);
  const commits = [];
  const options = {
    root,
    readCredential: async () => ({ apiBaseUrl: 'https://api.gala67.com', accessToken: 'jwt' }),
    fetchEntitlement: async ({ siteId }) => { assert.equal(siteId, SITE); return artifact; },
    commit: async (target) => commits.push(target)
  };
  assert.deepEqual(await acquireAttributionEntitlement(options), { changed: true, siteId: SITE });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.gala', 'entitlement.json'))), artifact);
  assert.deepEqual(await acquireAttributionEntitlement(options), { changed: false, siteId: SITE });
  assert.equal(commits.length, 1);
});

test('refuses a linked machine-managed directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-entitlement-command-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'gala-entitlement-outside-'));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1\nsite:\n  id: ${SITE}\n`);
  const { symlink } = await import('node:fs/promises');
  await symlink(outside, path.join(root, '.gala'));
  await assert.rejects(acquireAttributionEntitlement({
    root,
    readCredential: async () => ({}),
    fetchEntitlement: async () => artifact,
    commit: async () => assert.fail('must not commit')
  }), /.gala must be a real directory/);
});
