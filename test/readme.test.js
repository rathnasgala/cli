import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('README documents every public CLI command and required setup', () => {
  const commands = [
    'auth', 'configure', 'entitlement', 'scaffold', 'topology', 'validate',
    'new', 'doctor', 'hook', 'preview', 'publish', 'record-deployment',
    'refresh', 'upgrade', 'workflow'
  ];

  for (const command of commands) {
    assert.ok(readme.includes(`| \`gala ${command}`), command);
  }

  assert.match(readme, /https:\/\/github\.com\/apps\/gala67-app\/installations\/new/);
  assert.match(readme, /--installation-id YOUR_INSTALLATION_ID/);
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest auth github/);
});

test('README runnable Gala examples work without a global installation', () => {
  const consoleBlocks = [...readme.matchAll(/```console\n([\s\S]*?)```/g)]
    .map((match) => match[1]);

  for (const block of consoleBlocks) {
    assert.doesNotMatch(block, /^gala(?:\s|$)/m);
  }

  assert.match(readme, /npx --yes @rathnasgala\/cli@latest scaffold/);
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest publish/);
});
