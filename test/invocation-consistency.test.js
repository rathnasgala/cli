import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { CLI_INVOCATION, cliCommand } from '../src/cli/invocation.js';
import { COMMANDS } from '../src/commands-manifest.js';

test('every command usage has the one documented zero-install prefix', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.match(command.usage ?? cliCommand(name),
      new RegExp(`^${escapeRegex(CLI_INVOCATION)} ${name}(?:\\s|$)`), name);
  }
});

test('runtime source contains no actionable bare gala command', async () => {
  const files = await javascriptFiles(new URL('../src/', import.meta.url));
  const commandNames = Object.keys(COMMANDS).join('|');
  const bareCommand = new RegExp(`\\bgala\\s+(?:${commandNames})\\b`, 'i');

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, bareCommand, file.pathname);
  }
});

test('README examples never add a bare or redundant gala token', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  assert.doesNotMatch(readme, /^\s*gala\s/m);
  assert.doesNotMatch(readme, /@rathnasgala\/cli@latest\s+gala\b/);
  assert.match(readme, new RegExp(`${escapeRegex(CLI_INVOCATION)} --help`));
  assert.match(readme, new RegExp(`${escapeRegex(CLI_INVOCATION)} new `));
  assert.match(readme, new RegExp(`${escapeRegex(CLI_INVOCATION)} preview`));
  assert.match(readme, new RegExp(`${escapeRegex(CLI_INVOCATION)} publish`));
});

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await javascriptFiles(url));
    else if (entry.name.endsWith('.js')) files.push(url);
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
