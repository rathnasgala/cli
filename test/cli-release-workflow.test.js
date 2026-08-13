import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release-cli.yml', import.meta.url), 'utf8');

test('CLI release uses OIDC, exact tag matching, and no stored registry token', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: npm-cli-release/);
  assert.match(workflow, /npm@12\.0\.2/);
  assert.match(workflow, /test "\$actual" = "\$expected"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});

test('CLI release actions use immutable commit pins', () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  assert.ok(uses.every((value) => /@[0-9a-f]{40}$/.test(value)));
});
