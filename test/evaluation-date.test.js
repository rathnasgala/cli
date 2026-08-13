import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';

import { repositoryEvaluationDate } from '../src/evaluation-date.js';

async function fixture(timezone) {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-date-'));
  await mkdir(path.join(root, '.gala'));
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    themePackage: { name: '@rathnasgala/theme', version: '0.0.1', availableDesignThemes: ['editorial'] }
  }));
  await writeFile(path.join(root, 'site.config.yml'), stringify({
    schemaVersion: 1,
    site: { timezone },
    design: { theme: 'editorial' },
    framework: { themePackage: { name: '@rathnasgala/theme', version: '0.0.1' } }
  }));
  return root;
}

test('repository timezone controls the evaluation date through an injected clock', async () => {
  const instant = () => Date.parse('2026-06-14T20:00:00Z');
  assert.equal(
    await repositoryEvaluationDate({ root: await fixture('Asia/Kolkata'), now: instant }),
    '2026-06-15'
  );
  assert.equal(
    await repositoryEvaluationDate({ root: await fixture('America/Los_Angeles'), now: instant }),
    '2026-06-14'
  );
});

test('rejects invalid timezones, clocks, and linked configuration', async () => {
  await assert.rejects(
    async () => repositoryEvaluationDate({ root: await fixture('Mars/Olympus'), now: () => 0 }),
    /IANA/
  );
  await assert.rejects(
    async () => repositoryEvaluationDate({ root: await fixture('UTC'), now: () => Number.NaN }),
    /epoch milliseconds/
  );

  const root = await mkdtemp(path.join(tmpdir(), 'gala-date-link-'));
  const target = path.join(root, 'external.yml');
  await writeFile(target, stringify({ schemaVersion: 1, site: { timezone: 'UTC' } }));
  await symlink(target, path.join(root, 'site.config.yml'));
  await assert.rejects(() => repositoryEvaluationDate({ root, now: () => 0 }), /regular file/);
});
