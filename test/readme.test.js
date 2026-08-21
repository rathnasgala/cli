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
  // Every value scaffold derives must still be documented as an override, or the escape hatch is
  // undiscoverable for organisation-owned publications and multi-installation accounts.
  for (const flag of ['--owner', '--repository', '--target', '--installation-id']) {
    assert.ok(readme.includes(flag), flag);
  }
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest auth github/);
});

test('README quick start is a single scaffold command that does not demand derived values', () => {
  const quickStart = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('## Command reference'));

  const commands = [...quickStart.matchAll(/npx --yes @rathnasgala\/cli@latest ([a-z-]+)/g)]
    .map((match) => match[1]);
  assert.ok(commands.includes('scaffold'), 'quick start scaffolds');
  // auth and auth github are no longer steps the writer performs; scaffold runs them when needed.
  assert.ok(!commands.includes('auth'), 'quick start must not instruct a separate auth step');

  const scaffoldBlock = quickStart.slice(quickStart.indexOf('latest scaffold'));
  const firstBlockEnd = scaffoldBlock.indexOf('```');
  const firstScaffold = scaffoldBlock.slice(0, firstBlockEnd);
  for (const derived of ['--owner', '--installation-id', '--repository']) {
    assert.ok(!firstScaffold.includes(derived), `quick start must not require ${derived}`);
  }
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
