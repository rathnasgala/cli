import assert from 'node:assert/strict';
import test from 'node:test';

import { checkContent } from '../src/content.js';

function collector() {
  const lines = [];
  const record = (kind) => (message) => lines.push([kind, message]);
  return {
    lines,
    said: (kind) => lines.filter(([k]) => k === kind).map(([, m]) => m),
    terminal: {
      step: record('step'), done: record('done'), note: record('note'),
      fail: record('fail'), result: record('result'), blank: () => {}
    }
  };
}

test('reports every problem it found, not only the first', async () => {
  /*
   * Publishing stops on invalid content, so the writer needs the whole list in one pass. Stopping
   * at the first error means fixing one thing, running again, and only then learning about the next.
   */
  const { terminal, said } = collector();
  let failure;
  await assert.rejects(checkContent({
    terminal,
    root: '/site',
    regenerate: async () => ({ results: [
      { file: 'content/posts/one/index.en.md', errors: ['title is missing', 'id is not a ULID'], warnings: [] },
      { file: 'content/posts/two/index.en.md', errors: ['language does not match the filename'], warnings: [] },
      { file: 'content/posts/three/index.en.md', errors: [], warnings: [] }
    ] })
  }), (error) => {
    failure = error;
    return /Content check failed: 3 problems in 2 posts/.test(error.message);
  });

  assert.deepEqual(said('fail'), []);
  assert.equal(failure.detail, [
    'content/posts/one/index.en.md',
    '  - title is missing',
    '  - id is not a ULID',
    'content/posts/two/index.en.md',
    '  - language does not match the filename',
    'Fix these problems, then run the command again.'
  ].join('\n'));
  assert.deepEqual(said('note'), []);
});

test('shows relative paths and keeps the validator explanation intact', async () => {
  const { terminal } = collector();
  let failure;
  await assert.rejects(checkContent({
    terminal,
    root: '/site',
    regenerate: async () => ({ results: [{
      file: '/site/content/posts/notes/index.en.md',
      errors: [
        'Tag 1 ("Field Notes") is invalid. Use only lowercase letters and numbers separated by single hyphens, for example "field-notes".'
      ],
      warnings: []
    }] })
  }), (error) => {
    failure = error;
    return /Content check failed: 1 problem in 1 post/.test(error.message);
  });

  assert.equal(failure.detail, [
    'content/posts/notes/index.en.md',
    '  - Tag 1 ("Field Notes") is invalid. Use only lowercase letters and numbers separated by single hyphens, for example "field-notes".',
    'Fix this problem, then run the command again.'
  ].join('\n'));
});

test('counts one failing post as a post, not as posts', async () => {
  const { terminal } = collector();
  await assert.rejects(checkContent({
    terminal,
    root: '/site',
    regenerate: async () => ({ results: [{ file: 'a.md', errors: ['broken'], warnings: [] }] })
  }), /Content check failed: 1 problem in 1 post/);
});

test('warnings are shown and do not stop a publish', async () => {
  // A missing description is worth saying and not worth refusing over.
  const { terminal, said } = collector();
  const results = await checkContent({
    terminal,
    root: '/site',
    regenerate: async () => ({ results: [
      { file: 'a.md', errors: [], warnings: ['description is missing; SEO will use body text'] }
    ] })
  });

  assert.equal(results.length, 1);
  assert.deepEqual(said('fail'), []);
  assert.deepEqual(said('note'), ['a.md - description is missing; SEO will use body text']);
});

test('a validator that reports no warnings at all is not a crash', async () => {
  const { terminal } = collector();
  await checkContent({
    terminal, root: '/site', regenerate: async () => ({ results: [{ file: 'a.md', errors: [] }] })
  });
});
