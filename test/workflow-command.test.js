import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveNightlySchedule, writePublishWorkflow } from '../src/workflow-command.js';

const expression = (value) => `\${{ ${value} }}`;
const workflowTemplate = `on:
  push:
    branches: [__DEFAULT_BRANCH__]
  schedule:
    - cron: '__CRON__'
      timezone: '__TIMEZONE__'
jobs:
  publish:
    uses: __ACTION_REF__
    with:
      operation: build
      mode: __BUILD_MODE__
      site-id: __SITE_ID__
      api-base-url: ${expression('vars.GALA_API_BASE_URL')}
      output-directory: _site
      timezone: __TIMEZONE__
      config-path: site.config.yml
      floor-guard-percent: ${expression("vars.GALA_FLOOR_GUARD_PERCENT || '20'")}
      floor-guard-pages: ${expression("vars.GALA_FLOOR_GUARD_PAGES || '25'")}
      keepalive-threshold-days: ${expression("vars.GALA_KEEPALIVE_THRESHOLD_DAYS || '50'")}
      floor-guard-override-commit-sha: ${expression("contains(github.event.head_commit.message || '', 'Gala-Floor-Override:') && github.sha || ''")}
    secrets:
      site-secret: ${expression('secrets.GALA_SITE_SECRET')}
`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-workflow-'));
  await mkdir(path.join(root, '.gala'));
  await writeFile(path.join(root, '.gala', 'publish.yml.template'), workflowTemplate);
  return root;
}

test('derives a stable valid daily schedule from the site ID', () => {
  const first = deriveNightlySchedule('01K00000000000000000000000');
  assert.deepEqual(first, deriveNightlySchedule('01K00000000000000000000000'));
  assert.ok(first.minute >= 0 && first.minute <= 59);
  assert.ok(first.hour >= 0 && first.hour <= 23);
});

test('writes the explicit least-privilege reusable-workflow contract', async () => {
  const root = await fixture();
  const result = await writePublishWorkflow({
    root,
    siteId: '01K00000000000000000000000',
    timezone: 'America/Los_Angeles',
    actionRef: 'rathnasgala/publish/.github/workflows/publish.yml@v1'
  });
  const source = await readFile(result.target, 'utf8');
  assert.match(source, new RegExp(`cron: '${result.minute} ${result.hour} \\* \\* \\*'`));
  assert.match(source, /timezone: 'America\/Los_Angeles'/);
  assert.match(source, /uses: rathnasgala\/publish\/\.github\/workflows\/publish\.yml@v1/);
  assert.match(source, /site-id: 01K00000000000000000000000/);
  assert.match(source, /site-secret: \$\{\{ secrets\.GALA_SITE_SECRET \}\}/);
  assert.match(source, /keepalive-threshold-days: \$\{\{ vars\.GALA_KEEPALIVE_THRESHOLD_DAYS \|\| '50' \}\}/);
  assert.match(source, /contains\(github\.event\.head_commit\.message \|\| '', 'Gala-Floor-Override:'\) && github\.sha/);
  assert.doesNotMatch(source, /secrets:\s*inherit/);
  assert.doesNotMatch(source, /__[A-Z_]+__/);
});

test('defaults the public workflow reference to rathnasgala publish v1', async () => {
  const root = await fixture();
  await writePublishWorkflow({
    root,
    siteId: '01K00000000000000000000000',
    timezone: 'UTC'
  });
  const source = await readFile(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  assert.match(source, /uses: rathnasgala\/publish\/\.github\/workflows\/publish\.yml@v1/);
});

test('permits an exact immutable semver action reference for canary deployment', async () => {
  const root = await fixture();
  await writePublishWorkflow({
    root,
    siteId: '01K00000000000000000000000',
    timezone: 'UTC',
    actionRef: 'rathnasgala/publish/.github/workflows/publish.yml@v0.0.4'
  });
  const workflow = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /uses: rathnasgala\/publish\/.github\/workflows\/publish.yml@v0\.0\.4/);
});

test('rejects floating action versions, invalid timezones, and invalid modes', async () => {
  const root = await fixture();
  const valid = {
    root,
    siteId: 'site',
    timezone: 'UTC',
    actionRef: 'rathnasgala/publish/.github/workflows/publish.yml@v1'
  };
  await assert.rejects(() => writePublishWorkflow({ ...valid, actionRef: 'rathnasgala/publish@main' }), /major/);
  await assert.rejects(() => writePublishWorkflow({ ...valid, timezone: 'Mars/Olympus' }), /timezone/);
  await assert.rejects(() => writePublishWorkflow({ ...valid, buildMode: 'deploy-anywhere' }), /mode/);
});
