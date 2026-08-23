import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { upgrade } from '../src/commands/upgrade.js';

const root = path.resolve(new URL('../../site-template', import.meta.url).pathname);
const options = (values = {}, switches = {}) => ({
  value: (name) => values[name],
  on: (name) => switches[name] === true,
});
const terminal = () => {
  const messages = [];
  return {
    messages,
    result: (value) => messages.push(value),
    note: (value) => messages.push(value),
    done: (value) => messages.push(value),
    ask: async () => 'no',
  };
};

test('reports an exact current release without downloading or changing files', async () => {
  const output = terminal();
  const fetchImpl = async () => new Response(JSON.stringify({
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' } } },
  }));

  const result = await upgrade({ terminal: output, options: options({ root }), fetchImpl });

  assert.deepEqual(result, { changed: false, version: '2.0.0' });
  assert.match(output.messages.join('\n'), /Already current/);
});

test('refuses a channel outside the two documented release tracks', async () => {
  await assert.rejects(
    () => upgrade({ terminal: terminal(), options: options({ root, channel: 'beta' }) }),
    /channel must be latest or next/,
  );
});
