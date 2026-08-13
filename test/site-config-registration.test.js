import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import { writeRegisteredSiteConfiguration } from '../src/site-config-registration.js';

test('writes the server-resolved identity and provider-default topology atomically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-registered-config-'));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  id: unavailable
hosting:
  provider: github-pages
  topology: provider-default
  canonicalBaseUrl: unavailable
  pathPrefix: /unavailable
`);
  await writeRegisteredSiteConfiguration(root, {
    siteId: '01K00000000000000000000000',
    canonicalBaseUrl: 'https://rathnasgala.github.io/smoke01/',
    topology: 'provider-default'
  });
  const config = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
  assert.equal(config.site.id, '01K00000000000000000000000');
  assert.equal(config.hosting.canonicalBaseUrl, 'https://rathnasgala.github.io/smoke01');
  assert.equal(config.hosting.pathPrefix, '/smoke01');
});
