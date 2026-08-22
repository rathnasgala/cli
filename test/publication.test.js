import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { postUrl, readPublication } from '../src/publication.js';

async function publication(configuration) {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publication-'));
  await writeFile(path.join(root, 'site.config.yml'), configuration);
  return root;
}

const complete = [
  'site:',
  '  name: Field Notes',
  '  defaultLanguage: en',
  'hosting:',
  '  canonicalBaseUrl: https://ada.github.io',
  '  pathPrefix: /field-notes'
].join('\n');

test('assembles the address a writer would otherwise have to guess at', async () => {
  /*
   * The CLI knew every part of this and never said it: `new` printed a file path and `publish` said
   * the site would appear shortly. The language segment is not obvious from anything the writer
   * typed — it is not in the title, the filename or the folder — and being unable to find your own
   * post is a poor first minute with a publishing tool.
   */
  const found = await readPublication(await publication(complete));
  assert.equal(found.name, 'Field Notes');
  assert.equal(found.url, 'https://ada.github.io/field-notes/');
  assert.equal(postUrl(found, 'the-places-we-return-to'),
    'https://ada.github.io/field-notes/en/the-places-we-return-to/');
});

test('a publication served at the root has no path segment to add', async () => {
  const found = await readPublication(await publication([
    'site:',
    '  defaultLanguage: en',
    'hosting:',
    '  canonicalBaseUrl: https://notes.example.com',
    '  pathPrefix: /'
  ].join('\n')));
  assert.equal(found.url, 'https://notes.example.com/');
  assert.equal(postUrl(found, 'a-post'), 'https://notes.example.com/en/a-post/');
});

test('an explicit language wins over the default, for a translation', async () => {
  const found = await readPublication(await publication(complete));
  assert.equal(postUrl(found, 'a-post', 'fr'), 'https://ada.github.io/field-notes/fr/a-post/');
});

test('falls back to en when the configuration omits a default language', async () => {
  const found = await readPublication(await publication([
    'hosting:',
    '  canonicalBaseUrl: https://ada.github.io',
    '  pathPrefix: /notes'
  ].join('\n')));
  assert.equal(postUrl(found, 'a-post'), 'https://ada.github.io/notes/en/a-post/');
});

test('says nothing rather than guessing when it cannot read the configuration', async () => {
  // Not knowing the address is never worth failing a command over; the caller simply says less.
  assert.equal(await readPublication(path.join(tmpdir(), 'gala-not-a-publication')), null);
  assert.equal(await readPublication(await publication('{{ not yaml')), null);
  assert.equal(await readPublication(await publication('site:\n  name: Nameless\n')), null);
  assert.equal(postUrl(null, 'a-post'), null);
});
