import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createContentId } from '@rathnasgala/content-validation';
import { createPost } from '../src/new-command.js';

test('creates the standard post and media structure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  const result = await createPost({
    root,
    title: 'First Post',
    language: 'en',
    today: '2026-06-15'
  });
  const source = await readFile(result.postPath, 'utf8');
  assert.match(result.postPath, /content\/posts\/first-post\/index\.en\.md$/);
  assert.match(source, /publishAfterDate: 2026-06-15/);
  assert.doesNotMatch(source, /^slug:/m);
  assert.equal(result.metadata.slug, undefined);
  assert.match(source, /^[\s\S]*id: [0-7][0-9A-HJKMNP-TV-Z]{25}/m);
});

test('never overwrites an existing language variant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  const options = { root, title: 'First Post', language: 'en', today: '2026-06-15' };
  await createPost(options);
  await assert.rejects(() => createPost(options), { code: 'EEXIST' });
});

test('uses one canonical BCP-47 tag in frontmatter and the variant filename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  const result = await createPost({
    root,
    title: 'French Canadian Post',
    language: 'fr-ca',
    today: '2026-06-15'
  });

  assert.match(result.postPath, /index\.fr-CA\.md$/);
  assert.match(await readFile(result.postPath, 'utf8'), /language: fr-CA/);
});

test('defaults publishAfterDate to today in the configured site timezone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  await writeFile(
    path.join(root, 'site.config.yml'),
    'schemaVersion: 1\nsite:\n  timezone: America/Los_Angeles\n'
  );

  const result = await createPost({
    root,
    title: 'Local Calendar Date',
    language: 'en',
    now: () => Date.parse('2026-06-15T06:30:00Z')
  });

  assert.match(await readFile(result.postPath, 'utf8'), /publishAfterDate: 2026-06-14/);
});

test('encodes the injected creation instant in a new article ULID', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  await writeFile(
    path.join(root, 'site.config.yml'),
    'schemaVersion: 1\nsite:\n  timezone: America/Los_Angeles\n'
  );
  const instant = Date.parse('2026-06-15T06:30:45.123Z');

  const result = await createPost({
    root,
    title: 'Precise Creation Time',
    language: 'en',
    now: () => instant
  });

  assert.equal(result.metadata.id.slice(0, 10), createContentId(instant).slice(0, 10));
  assert.match(await readFile(result.postPath, 'utf8'), /publishAfterDate: 2026-06-14/);
});

test('language variants in one post folder reuse the existing article id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  const first = await createPost({
    root,
    title: 'Shared Identity',
    language: 'en',
    today: '2026-06-15'
  });
  const second = await createPost({
    root,
    title: 'Shared Identity',
    language: 'fr',
    today: '2026-06-15'
  });

  assert.equal(second.metadata.id, first.metadata.id);
  assert.match(await readFile(second.postPath, 'utf8'), new RegExp(`id: ${first.metadata.id}`));
});

test('refuses to extend a post folder with missing or conflicting article ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  const first = await createPost({
    root,
    title: 'Broken Identity',
    language: 'en',
    today: '2026-06-15'
  });
  const directory = path.dirname(first.postPath);
  await rm(path.join(directory, 'media'), { recursive: true });
  await writeFile(
    path.join(directory, 'index.fr.md'),
    '---\ntitle: French\npublishAfterDate: 2026-06-15\nlanguage: fr\n---\n'
  );
  await assert.rejects(
    () => createPost({
      root,
      title: 'Broken Identity',
      language: 'de',
      today: '2026-06-15'
    }),
    /missing a valid article id/
  );
  await assert.rejects(() => access(path.join(directory, 'media')), { code: 'ENOENT' });

  const conflictingId = `${first.metadata.id.slice(0, -1)}${first.metadata.id.endsWith('0') ? '1' : '0'}`;
  await writeFile(
    path.join(directory, 'index.fr.md'),
    `---\nid: ${conflictingId}\ntitle: French\npublishAfterDate: 2026-06-15\nlanguage: fr\n---\n`
  );
  await assert.rejects(
    () => createPost({
      root,
      title: 'Broken Identity',
      language: 'de',
      today: '2026-06-15'
    }),
    /conflicting article ids/
  );
});
