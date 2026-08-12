import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assignMissingContentIds } from '../src/assign-content-ids.js';

const ID = '01K00000000000000000000000';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-assign-id-'));
  const folder = path.join(root, 'content', 'posts', 'post');
  await mkdir(folder, { recursive: true });
  for (const language of ['en', 'fr']) {
    await writeFile(path.join(folder, `index.${language}.md`), `---
title: ${language}
publishAfterDate: 2026-06-15
language: ${language}
custom: preserved
---
Body
`);
  }
  return { root, folder };
}

test('assigns one injected canonical ID to every missing variant without reserializing YAML', async () => {
  const { root, folder } = await fixture();
  const assigned = await assignMissingContentIds(root, { idFactory: () => ID });
  assert.equal(assigned.length, 2);
  for (const language of ['en', 'fr']) {
    const source = await readFile(path.join(folder, `index.${language}.md`), 'utf8');
    assert.match(source, new RegExp(`^---\\nid: ${ID}\\ntitle: ${language}\\n`));
    assert.match(source, /custom: preserved\n---\nBody\n$/);
  }
});

test('repairs a partial prior assignment using the existing folder ID', async () => {
  const { root, folder } = await fixture();
  const english = path.join(folder, 'index.en.md');
  await writeFile(english, (await readFile(english, 'utf8')).replace('---\n', `---\nid: ${ID}\n`));
  const assigned = await assignMissingContentIds(root, {
    idFactory: () => { throw new Error('must not generate'); }
  });
  assert.deepEqual(assigned, [{ file: path.join(folder, 'index.fr.md'), id: ID }]);
});

test('does not guess when existing IDs conflict or frontmatter is malformed', async () => {
  const { root, folder } = await fixture();
  await writeFile(path.join(folder, 'index.en.md'), `---\nid: ${ID}\ntitle: en\n---\n`);
  await writeFile(
    path.join(folder, 'index.fr.md'),
    '---\nid: 01K00000000000000000000001\ntitle: fr\n---\n'
  );
  assert.deepEqual(await assignMissingContentIds(root, { idFactory: () => ID }), []);
});

test('does not mutate nested files outside the post layout', async () => {
  const { root, folder } = await fixture();
  const nestedFolder = path.join(folder, 'nested');
  const nestedFile = path.join(nestedFolder, 'index.de.md');
  await mkdir(nestedFolder);
  await writeFile(nestedFile, `---
title: nested
publishAfterDate: 2026-06-15
language: de
---
Body
`);

  const assigned = await assignMissingContentIds(root, { idFactory: () => ID });

  assert.deepEqual(
    assigned.map(({ file }) => file).sort(),
    ['index.en.md', 'index.fr.md'].map((name) => path.join(folder, name)).sort()
  );
  assert.doesNotMatch(await readFile(nestedFile, 'utf8'), /^---\nid:/);
});

test('preserves an accepted BOM and frontmatter line-ending style while inserting an id', async () => {
  for (const { name, prefix, newline } of [
    { name: 'bom', prefix: '\uFEFF', newline: '\n' },
    { name: 'crlf', prefix: '', newline: '\r\n' }
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), `gala-assign-id-${name}-`));
    const folder = path.join(root, 'content', 'posts', name);
    const file = path.join(folder, 'index.en.md');
    await mkdir(folder, { recursive: true });
    const source = [
      `${prefix}---`,
      'title: Accepted bytes',
      'publishAfterDate: 2026-06-15',
      'language: en',
      '---',
      'Body',
      ''
    ].join(newline);
    await writeFile(file, source);

    assert.deepEqual(await assignMissingContentIds(root, { idFactory: () => ID }), [
      { file, id: ID }
    ]);
    assert.equal(
      await readFile(file, 'utf8'),
      source.replace(`${prefix}---${newline}`, `${prefix}---${newline}id: ${ID}${newline}`)
    );
  }
});

test('assigns a valid sibling without modifying malformed translation frontmatter', async () => {
  const { root, folder } = await fixture();
  const malformed = path.join(folder, 'index.fr.md');
  const malformedSource = '---\ntitle: [broken\n---\nBody\n';
  await writeFile(malformed, malformedSource);

  assert.deepEqual(await assignMissingContentIds(root, { idFactory: () => ID }), [
    { file: path.join(folder, 'index.en.md'), id: ID }
  ]);
  assert.match(await readFile(path.join(folder, 'index.en.md'), 'utf8'), new RegExp(`^---\\nid: ${ID}\\n`));
  assert.equal(await readFile(malformed, 'utf8'), malformedSource);
});
