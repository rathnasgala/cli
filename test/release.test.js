import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release-cli.yml', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('publishes with trusted publishing and provenance, never a stored token', () => {
  /*
   * A registry token in CI is a credential that can be exfiltrated and reused; OIDC is scoped to
   * one workflow run and cannot leave it. Provenance is what lets anyone verify that the tarball on
   * npm was built from this repository at this commit.
   */
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /npm publish[^\n]*--provenance/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test('refuses to publish a tag that disagrees with the version', () => {
  // A tag and a version that drift apart mean `npm install pkg@1.2.3` and `git checkout v1.2.3`
  // are different code, and nobody finds out until they are debugging the wrong source.
  assert.match(workflow, /GITHUB_REF_NAME#v/);
  assert.match(workflow, /test "\$actual" = "\$expected"/);
});

test('runs the suite before publishing, not after', () => {
  const publishAt = workflow.indexOf('npm publish');
  assert.ok(workflow.indexOf('npm test') < publishAt, 'tests must gate the publish');
  assert.ok(workflow.indexOf('npm run lint') < publishAt, 'lint must gate the publish');
});

test('ships the CLI and nothing else', () => {
  assert.deepEqual(manifest.files, ['src']);
  assert.equal(manifest.bin.gala, 'src/index.js');
  assert.equal(manifest.type, 'module');
});

test('requires a Node the README also asks for', () => {
  // v0 promised 18 in package.json and 24 in the README, so neither was a commitment.
  assert.equal(manifest.engines.node, '>=20');
});
