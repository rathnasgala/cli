import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPost } from '../src/commands/new.js';

test('new points zero-install users to an executable preview command', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  await writeFile(path.join(root, 'site.config.yml'), [
    'site:',
    '  defaultLanguage: en',
    'hosting:',
    '  canonicalBaseUrl: https://writer.github.io',
    '  pathPrefix: /notes'
  ].join('\n'));
  const notes = [];

  await createPost({
    terminal: {
      done() {}, result() {}, blank() {}, note(message) { notes.push(message); }
    },
    options: {
      positional: ['Your first post'],
      value(name) { return name === 'today' ? '2026-08-29' : undefined; }
    },
    cwd: root,
    now: () => 1787990400000
  });

  assert.match(notes.join('\n'), /npx --yes @rathnasgala\/cli@latest preview/);
  assert.doesNotMatch(notes.join('\n'), /then: gala preview/);
});
