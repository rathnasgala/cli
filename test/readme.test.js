import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { COMMANDS } from '../src/commands-manifest.js';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

test('documents every command that exists, and nothing that does not', () => {
  /*
   * v0's README outlived its commands by weeks: it taught a `connect` command that never existed,
   * and kept documenting nine that had been removed. Documentation that drifts is worse than none —
   * a writer trusts it and loses an afternoon. Nothing tied the two together until now.
   */
  // Matched as an invocation rather than as a word: "the publishing workflow" is a noun, and a
  // removed command is only really still documented if a writer could try to run it.
  const invoked = (name) => new RegExp(`(?:latest |\`)${name}\\b`);
  for (const command of Object.keys(COMMANDS)) {
    assert.match(readme, invoked(command), `README omits ${command}`);
  }
  for (const gone of ['scaffold', 'validate', 'workflow', 'record-deployment', 'configure',
    'topology', 'refresh', 'entitlement', 'connect']) {
    assert.doesNotMatch(readme, invoked(gone), `README still documents ${gone}`);
  }
});

test('every documented option is one a command actually accepts', () => {
  const known = new Set([
    // Handled by the dispatcher rather than by any one command.
    'help',
    ...Object.values(COMMANDS).flatMap(({ flags = [], switches = [] }) => [...flags, ...switches])
  ]);

  // Requires a letter after the dashes, so Markdown frontmatter fences are not read as options.
  for (const [, option] of readme.matchAll(/`--([a-z][a-z-]*)`/g)) {
    assert.ok(known.has(option), `README documents --${option}, which no command accepts`);
  }
});

test('every example runs without a global install', () => {
  for (const [, block] of readme.matchAll(/```console\n([\s\S]*?)```/g)) {
    for (const line of block.split('\n')) {
      const command = line.trim();
      if (command === '' || command.startsWith('#')) continue;
      assert.doesNotMatch(command, /^gala\b/, `"${command}" assumes a global install`);
    }
  }
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest init/);
  assert.match(readme, /npx --yes @rathnasgala\/cli@latest publish/);
});
