import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aiReadinessChecks } from '../src/commands/doctor.js';

const runtimeFiles = [
  'lib/ai-discovery.js', 'lib/seo.js', 'src/llms.11ty.js', 'src/robots.11ty.js',
  'src/rsl.11ty.js', 'src/article-markdown.11ty.js', 'src/article-provenance.11ty.js',
  'src/_includes/layouts/base.njk'
];

async function fixture(config, workflow = 'attest-build: false\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gala-doctor-ai-'));
  for (const relative of runtimeFiles) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, relative.endsWith('base.njk')
      ? '<link rel="alternate" type="text/markdown"><link rel="describedby">' : 'managed\n');
  }
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  await writeFile(path.join(root, '.github/workflows/publish.yml'), workflow);
  await writeFile(path.join(root, 'site.config.yml'), config);
  await mkdir(path.join(root, 'content/posts/example'), { recursive: true });
  await writeFile(path.join(root, 'content/posts/example/index.en.md'),
    '---\ndescription: Useful summary\n---\n\n> [!ANSWER]\n> Direct answer.\n');
  return root;
}

test('AI doctor recognises managed discovery with no author rights declaration', async () => {
  const root = await fixture('aiPublishing:\n  attestBuilds: false\n');
  try {
    const checks = await aiReadinessChecks(root);
    assert.deepEqual(checks.map(({ state }) => state), ['ok', 'ok', 'ok']);
    assert.match(checks[1].detail, /RSL is intentionally absent/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('AI doctor verifies the exact rights digest and least-privilege attestation workflow', async () => {
  const declaration = {
    indexing: 'allow', aiSearch: 'allow', modelTraining: 'block',
    reuse: 'attribution-required', commercialUse: 'license-required',
    licenseUrl: 'https://example.test/license'
  };
  const digest = createHash('sha256').update(JSON.stringify(declaration)).digest('hex');
  const root = await fixture(`aiPublishing:
  indexing: allow
  aiSearch: allow
  modelTraining: block
  reuse: attribution-required
  commercialUse: license-required
  licenseUrl: https://example.test/license
  confirmation: ${digest}
  attestBuilds: true
`, 'permissions:\n  id-token: write\n  attestations: write\nattest-build: true\n');
  try {
    const checks = await aiReadinessChecks(root);
    assert.equal(checks[1].state, 'ok');
    assert.match(checks[1].detail, /with build attestations/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('AI doctor reports stale policy/workflow state and article improvements separately', async () => {
  const declaration = {
    indexing: 'allow', aiSearch: 'allow', modelTraining: 'block',
    reuse: 'attribution-required', commercialUse: 'block', licenseUrl: ''
  };
  const digest = createHash('sha256').update(JSON.stringify(declaration)).digest('hex');
  const root = await fixture(`aiPublishing:
  indexing: allow
  aiSearch: allow
  modelTraining: block
  reuse: attribution-required
  commercialUse: block
  confirmation: ${digest}
  attestBuilds: false
`, 'permissions:\n  id-token: write\n');
  try {
    await writeFile(path.join(root, 'content/posts/example/index.en.md'), '---\ntitle: Example\n---\nBody\n');
    const checks = await aiReadinessChecks(root);
    assert.equal(checks[1].state, 'wrong');
    assert.match(checks[1].detail, /workflow disagree|permissions remain enabled/);
    assert.equal(checks[2].state, 'advisory');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('AI doctor classifies an invalid rights policy as an actionable problem', async () => {
  const root = await fixture('aiPublishing:\n  indexing: sometimes\n');
  try {
    const checks = await aiReadinessChecks(root);
    assert.equal(checks[1].state, 'wrong');
    assert.match(checks[1].detail, /invalid AI publishing policy/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('AI doctor rejects an incomplete rights declaration instead of changing its meaning', async () => {
  const root = await fixture(`aiPublishing:
  indexing: allow
  confirmation: ${'a'.repeat(64)}
`);
  try {
    const checks = await aiReadinessChecks(root);
    assert.equal(checks[1].state, 'wrong');
    assert.match(checks[1].detail, /all five rights choices/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('AI doctor explains the robots limitation on a GitHub project-site path', async () => {
  const declaration = {
    indexing: 'allow', aiSearch: 'allow', modelTraining: 'block',
    reuse: 'attribution-required', commercialUse: 'block', licenseUrl: ''
  };
  const digest = createHash('sha256').update(JSON.stringify(declaration)).digest('hex');
  const root = await fixture(`hosting:
  canonicalBaseUrl: https://writer.github.io
  pathPrefix: /notes
aiPublishing:
  indexing: allow
  aiSearch: allow
  modelTraining: block
  reuse: attribution-required
  commercialUse: block
  confirmation: ${digest}
`);
  try {
    const checks = await aiReadinessChecks(root);
    assert.equal(checks[1].state, 'advisory');
    assert.match(checks[1].detail, /not origin-root on this GitHub project URL/);
    assert.match(checks[1].fix, /Connect a custom domain/);
  } finally {
    await rm(root, { recursive: true });
  }
});
