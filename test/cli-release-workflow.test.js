import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release-cli.yml', import.meta.url), 'utf8');
const pushScript = await readFile(new URL('../scripts/push.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);

test('CLI package metadata is already canonical before npm publishes it', () => {
  assert.equal(packageJson.bin.gala, 'src/index.js');
  assert.equal(packageJson.repository.url, 'git+https://github.com/rathnasgala/cli.git');
});

test('push validates then creates and publishes one npm patch-version commit and tag', () => {
  assert.equal(packageJson.scripts.preversion, 'npm test && npm run lint');
  assert.equal(
    packageJson.scripts.push,
    'node scripts/push.js'
  );
  const testIndex = pushScript.indexOf("[npmExecutable, 'test']");
  const lintIndex = pushScript.indexOf("[npmExecutable, 'run', 'lint']");
  const versionIndex = pushScript.indexOf("npmExecutable, 'version', 'patch'");
  const addIndex = pushScript.indexOf("['add', '.']");
  const commitIndex = pushScript.indexOf("['commit', '-m', commitMessage]");
  const tagIndex = pushScript.indexOf("['tag', tag]");
  const pushIndex = pushScript.indexOf("['push', '--atomic', 'origin', 'HEAD'");
  assert.ok([testIndex, lintIndex, versionIndex, addIndex, commitIndex, tagIndex, pushIndex]
    .every((index) => index >= 0));
  assert.ok(testIndex < lintIndex);
  assert.ok(lintIndex < versionIndex);
  assert.ok(versionIndex < addIndex);
  assert.ok(addIndex < commitIndex);
  assert.ok(commitIndex < tagIndex);
  assert.ok(tagIndex < pushIndex);
  assert.match(pushScript, /replaceAll\('%s', version\)/);
});

test('push requires exactly one non-empty commit message before changing a version', () => {
  for (const args of [[], [''], ['one', 'two']]) {
    const result = spawnSync(process.execPath, ['scripts/push.js', ...args], {
      encoding: 'utf8',
      shell: false
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: npm run push -- "commit message"/);
  }
});

test('CLI release uses OIDC, exact tag matching, and no stored registry token', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: npm-cli-release/);
  assert.match(workflow, /node-version: 24\.15\.0/);
  assert.match(workflow, /npm@12\.0\.2/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /npm install --ignore-scripts/);
  assert.match(workflow, /test "\$actual" = "\$expected"/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
});

test('CLI release actions use immutable commit pins', () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  assert.ok(uses.every((value) => /@[0-9a-f]{40}$/.test(value)));
});
