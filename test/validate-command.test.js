import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_MANIFEST_PATH,
  regenerateBuildManifest,
  validateContent
} from '../src/validate-command.js';

async function fixture(post, filename = 'index.en.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-validation-'));
  const postDirectory = path.join(root, 'content', 'posts', 'example');
  await mkdir(postDirectory, { recursive: true });
  await mkdir(path.join(root, '.gala'));
  await writeFile(path.join(root, '.gala', 'managed-files.json'), JSON.stringify({
    themePackage: { name: '@rathnasgala/theme', version: '0.0.1', availableDesignThemes: ['editorial'] }
  }));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: Asia/Kolkata
design:
  theme: editorial
framework:
  themePackage:
    name: "@rathnasgala/theme"
    version: "0.0.1"
`);
  await writeFile(path.join(postDirectory, filename), post, 'utf8');
  return root;
}

test('derives today from repository timezone when no override is supplied', async () => {
  const root = await fixture(`---
title: Timezone
publishAfterDate: 2026-06-15
language: en
editHistory:
  - 2026-06-15 Published
---
Body
`);
  const results = await validateContent({
    root,
    now: () => Date.parse('2026-06-14T20:00:00Z')
  });
  assert.deepEqual(results[0].errors, []);
});

test('validates repository content fully offline', async () => {
  const root = await fixture(`---
title: Valid
publishAfterDate: 2026-06-15
language: en
---
Body
`);
  const results = await validateContent({ root, today: '2026-06-15' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].errors, []);
});

test('requires the filename language to match frontmatter after BCP-47 canonicalization', async () => {
  const mismatchRoot = await fixture(`---
title: Mismatch
publishAfterDate: 2026-06-15
language: fr
---
Body
`);
  const mismatch = await validateContent({ root: mismatchRoot, today: '2026-06-15' });
  assert.deepEqual(mismatch[0].errors, [
    'filename language en does not match frontmatter language fr'
  ]);

  const canonicalRoot = await mkdtemp(path.join(tmpdir(), 'gala-validation-'));
  const directory = path.join(canonicalRoot, 'content', 'posts', 'example');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(canonicalRoot, 'site.config.yml'),
    'schemaVersion: 1\nsite:\n  timezone: UTC\n');
  await writeFile(path.join(directory, 'index.fr-ca.md'), `---
title: Canonical
publishAfterDate: 2026-06-15
language: fr-CA
---
Body
`);
  const canonical = await validateContent({ root: canonicalRoot, today: '2026-06-15' });
  assert.deepEqual(canonical[0].errors, []);
});

test('skips every language alias that canonicalizes to the same emitted variant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-validation-'));
  const directory = path.join(root, 'content', 'posts', 'same');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);
  for (const language of ['iw', 'he']) {
    await writeFile(path.join(directory, `index.${language}.md`), `---
title: Same canonical language
publishAfterDate: 2026-06-15
language: ${language}
---
Body
`);
  }

  const { results, manifest } = await regenerateBuildManifest({
    root,
    today: '2026-06-15',
    idFactory: () => '01K00000000000000000000000'
  });

  assert.equal(results.length, 2);
  assert.ok(results.every(({ errors }) => errors.includes(
    'duplicate slug-language variant: same (he)'
  )));
  assert.deepEqual(manifest.posts, []);
});

test('rejects post variants outside content/posts/<post-folder>/index.<lang>.md', async () => {
  const root = await fixture(`---
title: Valid sibling
publishAfterDate: 2026-06-15
language: en
---
Body
`);
  const nested = path.join(root, 'content', 'posts', 'example', 'nested');
  await mkdir(nested);
  await writeFile(path.join(nested, 'index.fr.md'), `---
title: Nested
publishAfterDate: 2026-06-15
language: fr
---
Body
`);

  const results = await validateContent({ root, today: '2026-06-15' });
  const valid = results.find(({ file }) => file.endsWith('example/index.en.md'));
  const invalid = results.find(({ file }) => file.endsWith('nested/index.fr.md'));
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(invalid.errors, [
    'post path must be content/posts/<post-folder>/index.<lang>.md'
  ]);
});

test('isolates an invalid post with file-specific errors', async () => {
  const root = await fixture(`---
title: Invalid
createdDate: 2026-02-30
publishAfterDate: tomorrow
language: en
---
Body
`);
  const validDirectory = path.join(root, 'content', 'posts', 'valid');
  await mkdir(validDirectory, { recursive: true });
  await writeFile(path.join(validDirectory, 'index.fr.md'), `---
title: Valid
createdDate: 2026-06-14
publishAfterDate: 2026-06-15
language: fr
---
Body
`);
  const results = await validateContent({ root, today: '2026-06-15' });
  const invalid = results.find(({ file }) => file.endsWith('index.en.md'));
  const valid = results.find(({ file }) => file.endsWith('index.fr.md'));
  assert.match(invalid.file, /index\.en\.md$/);
  assert.match(invalid.errors.join('\n'), /publishAfterDate/);
  assert.match(invalid.errors.join('\n'), /createdDate/);
  assert.deepEqual(valid.errors, []);
});

test('emits a valid translation with a stable id when its sibling frontmatter is malformed', async () => {
  const root = await fixture(`---
title: Valid identity
publishAfterDate: 2026-06-15
language: en
---
Body
`);
  const malformed = path.join(root, 'content', 'posts', 'example', 'index.fr.md');
  await writeFile(malformed, '---\ntitle: [broken\n---\nBody\n');
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);

  const { results, manifest } = await regenerateBuildManifest({
    root,
    today: '2026-06-15',
    idFactory: () => '01K00000000000000000000000'
  });

  assert.equal(results.find(({ file }) => file === malformed).errors.length > 0, true);
  assert.equal(manifest.posts.length, 1);
  assert.equal(manifest.posts[0].id, '01K00000000000000000000000');
});

test('skips one unsafe canonical without aborting valid sibling emission', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: Unsafe canonical
publishAfterDate: 2026-06-15
language: en
canonicalUrl: javascript:alert(1)
---
Body
`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);
  const validDirectory = path.join(root, 'content', 'posts', 'valid');
  await mkdir(validDirectory, { recursive: true });
  await writeFile(path.join(validDirectory, 'index.fr.md'), `---
id: 01K00000000000000000000001
title: Valid sibling
publishAfterDate: 2026-06-15
language: fr
canonicalUrl: https://canonical.example/valid
---
Body
`);

  const { results, manifest } = await regenerateBuildManifest({ root, today: '2026-06-15' });
  const invalid = results.find(({ data }) => data?.language === 'en');
  assert.deepEqual(invalid.errors, ['canonicalUrl must use HTTPS without credentials']);
  assert.equal(manifest.posts.length, 1);
  assert.equal(manifest.posts[0].language, 'fr');
  assert.equal(manifest.posts[0].canonicalUrl, 'https://canonical.example/valid');
});

test('accepts existing post-local media and rejects missing media', async () => {
  const root = await fixture(`---
title: Media
publishAfterDate: 2026-06-15
language: en
coverImage: media/cover.png
---
![Diagram](media/missing.png)
`);
  const mediaDirectory = path.join(root, 'content', 'posts', 'example', 'media');
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, 'cover.png'), 'fixture', 'utf8');

  const results = await validateContent({ root, today: '2026-06-15' });
  assert.deepEqual(results[0].errors, ['media reference does not exist: media/missing.png']);
});

test('rejects media traversal outside the post folder', async () => {
  const root = await fixture(`---
title: Traversal
publishAfterDate: 2026-06-15
language: en
coverImage: ../../secret.png
---
Body
`);
  const results = await validateContent({ root, today: '2026-06-15' });
  assert.deepEqual(results[0].errors, [
    'media reference escapes the post folder: ../../secret.png'
  ]);
});

test('rejects a post-local media symlink resolving outside the post folder', async () => {
  const root = await fixture(`---
title: Symlink escape
publishAfterDate: 2026-06-15
language: en
coverImage: media/cover.png
---
Body
`);
  const outside = path.join(root, 'outside.png');
  const mediaDirectory = path.join(root, 'content', 'posts', 'example', 'media');
  await writeFile(outside, 'outside', 'utf8');
  await mkdir(mediaDirectory, { recursive: true });
  await symlink(outside, path.join(mediaDirectory, 'cover.png'));

  const results = await validateContent({ root, today: '2026-06-15' });
  assert.deepEqual(results[0].errors, [
    'media reference resolves outside the post folder: media/cover.png'
  ]);
});

test('accepts a media symlink whose real target remains inside the post folder', async () => {
  const root = await fixture(`---
title: Internal symlink
publishAfterDate: 2026-06-15
language: en
coverImage: media/cover.png
---
Body
`);
  const mediaDirectory = path.join(root, 'content', 'posts', 'example', 'media');
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, 'source.png'), 'inside', 'utf8');
  await symlink('source.png', path.join(mediaDirectory, 'cover.png'));

  const results = await validateContent({ root, today: '2026-06-15' });
  assert.deepEqual(results[0].errors, []);
});

test('carries validated media copies forward and warns when SEO description uses body text', async () => {
  const root = await fixture(`---
title: Media manifest
publishAfterDate: 2026-06-15
language: en
coverImage: media/cover.png
---
Body text for the description.
`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /blog
`);
  const mediaDirectory = path.join(root, 'content', 'posts', 'example', 'media');
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, 'cover.png'), 'image', 'utf8');

  const { results, manifest } = await regenerateBuildManifest({
    root,
    today: '2026-06-15',
    idFactory: () => '01K00000000000000000000000'
  });

  assert.deepEqual(results[0].errors, []);
  assert.deepEqual(results[0].warnings, [
    'description is missing; SEO metadata will use the first 160 characters of rendered body text'
  ]);
  assert.deepEqual(manifest.posts[0].media, [{
    source: 'content/posts/example/media/cover.png',
    output: 'en/example/media/cover.png'
  }]);
  assert.deepEqual(manifest.assignedContentIds.map(({ source, id }) => ({ source, id })), [{
    source: 'content/posts/example/index.en.md',
    id: '01K00000000000000000000000'
  }]);
  assert.match(manifest.assignedContentIds[0].fileHash, /^[a-f0-9]{64}$/);
});

test('rejects remote and root-relative cover images because OG media must be repository-owned', async () => {
  for (const coverImage of ['https://cdn.example/cover.png', '/cover.png']) {
    const root = await fixture(`---
title: External cover
publishAfterDate: 2026-06-15
language: en
coverImage: ${coverImage}
---
Body
`);
    const results = await validateContent({ root, today: '2026-06-15' });
    assert.deepEqual(results[0].errors, [
      `coverImage must be relative to the post folder: ${coverImage}`
    ]);
  }
});

test('accepts one article id across language variants in the same folder', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: English
slug: shared
publishAfterDate: 2026-06-15
language: en
---
`);
  const directory = path.join(root, 'content', 'posts', 'example');
  await writeFile(path.join(directory, 'index.fr.md'), `---
id: 01K00000000000000000000000
title: French
slug: shared
publishAfterDate: 2026-06-15
language: fr
---
`);

  const results = await validateContent({ root, today: '2026-06-15' });
  assert.equal(results.length, 2);
  assert.ok(results.every(({ errors }) => errors.length === 0));
});

test('validates folder-derived slugs without normalization and applies one explicit slug to all variants', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: English
slug: pinned-url
publishAfterDate: 2026-06-15
language: en
---
`);
  const directory = path.join(root, 'content', 'posts', 'example');
  await writeFile(path.join(directory, 'index.fr.md'), `---
id: 01K00000000000000000000000
title: French
publishAfterDate: 2026-06-15
language: fr
---
`);

  const valid = await validateContent({ root, today: '2026-06-15' });
  assert.ok(valid.every(({ errors }) => errors.length === 0));

  await writeFile(path.join(directory, 'index.fr.md'), `---
id: 01K00000000000000000000000
title: French
slug: other-url
publishAfterDate: 2026-06-15
language: fr
---
`);
  const conflicting = await validateContent({ root, today: '2026-06-15' });
  assert.ok(conflicting.every(({ errors }) =>
    errors.includes('language variants in one post folder declare conflicting slugs')
  ));
});

test('an invalid explicit folder slug skips every language variant without aborting manifest generation', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: English
slug: Bad_slug
publishAfterDate: 2026-06-15
language: en
---
`);
  const directory = path.join(root, 'content', 'posts', 'example');
  await writeFile(path.join(directory, 'index.fr.md'), `---
id: 01K00000000000000000000000
title: French
publishAfterDate: 2026-06-15
language: fr
---
`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);

  const { results, manifest } = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.equal(manifest.posts.length, 0);
  assert.ok(results.every(({ errors }) =>
    errors.includes('explicit slug must be lowercase [a-z0-9-] and at most 80 characters')
  ));
});

test('rejects illegal and reserved post folder names without silently slugifying them', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: Valid
publishAfterDate: 2026-06-15
language: en
---
`);
  const posts = path.join(root, 'content', 'posts');
  await mkdir(path.join(posts, 'My Post!'));
  await writeFile(path.join(posts, 'My Post!', 'index.fr.md'), `---
id: 01K00000000000000000000001
title: Invalid folder
publishAfterDate: 2026-06-15
language: fr
---
`);
  await mkdir(path.join(posts, 'feed'));
  await writeFile(path.join(posts, 'feed', 'index.de.md'), `---
id: 01K00000000000000000000002
title: Reserved folder
publishAfterDate: 2026-06-15
language: de
---
`);

  const results = await validateContent({ root, today: '2026-06-15' });
  const byLanguage = Object.fromEntries(results.map((result) => [result.data.language, result.errors]));
  assert.match(byLanguage.fr.join('\n'), /post folder "My Post!" is invalid/);
  assert.match(byLanguage.fr.join('\n'), /lowercase \[a-z0-9-\]/);
  assert.deepEqual(byLanguage.de, ['post folder is reserved: feed']);
});

test('rejects conflicting ids in one folder and one id reused across folders', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: English
slug: shared
publishAfterDate: 2026-06-15
language: en
---
`);
  const firstDirectory = path.join(root, 'content', 'posts', 'example');
  await writeFile(path.join(firstDirectory, 'index.fr.md'), `---
id: 01K00000000000000000000001
title: French
slug: shared
publishAfterDate: 2026-06-15
language: fr
---
`);
  const secondDirectory = path.join(root, 'content', 'posts', 'other');
  await mkdir(secondDirectory, { recursive: true });
  await writeFile(path.join(secondDirectory, 'index.de.md'), `---
id: 01K00000000000000000000000
title: German
slug: other
publishAfterDate: 2026-06-15
language: de
---
`);

  const results = await validateContent({ root, today: '2026-06-15' });
  const byLanguage = Object.fromEntries(results.map((result) => [result.data.language, result.errors]));
  assert.deepEqual(byLanguage.en, [
    'language variants in one post folder must share one article id',
    'article id is reused across post folders: 01K00000000000000000000000'
  ]);
  assert.deepEqual(byLanguage.fr, [
    'language variants in one post folder must share one article id'
  ]);
  assert.deepEqual(byLanguage.de, [
    'article id is reused across post folders: 01K00000000000000000000000'
  ]);
});

test('regenerates a current effective manifest and expresses skipped posts by absence', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: Published
publishAfterDate: 2026-06-15
language: fr-ca
canonicalUrl: https://canonical.example/published
---
Body
`, 'index.fr-ca.md');
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /notes
`);
  const posts = path.join(root, 'content', 'posts');
  await mkdir(path.join(posts, 'future'));
  await writeFile(path.join(posts, 'future', 'index.en.md'), `---
id: 01K00000000000000000000001
title: Future
publishAfterDate: 2026-06-16
language: en
---
Future
`);
  await mkdir(path.join(posts, 'invalid'));
  await writeFile(path.join(posts, 'invalid', 'index.en.md'), 'invalid');
  const manifestPath = path.join(root, BUILD_MANIFEST_PATH);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, '{"stale":true}\n');

  const { results, manifest } = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.equal(results.filter(({ errors }) => errors.length > 0).length, 1);
  assert.equal(manifest.posts.length, 1);
  assert.deepEqual(manifest.redirects, []);
  assert.deepEqual(manifest.posts[0], {
    source: 'content/posts/example/index.fr-ca.md',
    id: '01K00000000000000000000000',
    rawFrontmatter: {
      id: '01K00000000000000000000000',
      title: 'Published',
      publishAfterDate: '2026-06-15',
      language: 'fr-ca',
      canonicalUrl: 'https://canonical.example/published'
    },
    frontmatter: {
      id: '01K00000000000000000000000',
      title: 'Published',
      publishAfterDate: '2026-06-15',
      language: 'fr-CA',
      canonicalUrl: 'https://canonical.example/published',
      slug: 'example'
    },
    contentBody: 'Body\n',
    body: 'Body\n',
    slug: 'example',
    language: 'fr-CA',
    relativeUrl: '/fr-CA/example/',
    pageUrl: 'https://example.com/notes/fr-CA/example/',
    canonicalUrl: 'https://canonical.example/published',
    media: [],
    publicationState: 'published'
  });
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), manifest);
  await access(manifestPath);
});

test('stable ULID detects a folder rename and an explicit old-slug pin preserves the URL', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: Renamed folder
publishAfterDate: 2026-06-01
language: en
---
Body
`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);
  await mkdir(path.join(root, '.gala'), { recursive: true });
  await writeFile(path.join(root, '.gala', 'publication-state.yml'), `schemaVersion: 1
posts:
  - id: 01K00000000000000000000000
    slug: old-folder
    languages:
      en:
        firstPublishedOn: 2026-06-01
`);

  const renamed = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.deepEqual(renamed.manifest.posts, []);
  assert.deepEqual(renamed.results[0].errors, [
    'published slug changed from old-folder; pin that slug explicitly to keep the URL'
  ]);

  const source = path.join(root, 'content', 'posts', 'example', 'index.en.md');
  await writeFile(source, `---
id: 01K00000000000000000000000
title: Renamed folder
slug: old-folder
publishAfterDate: 2026-06-01
language: en
---
Body
`);
  const pinned = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.deepEqual(pinned.results[0].errors, []);
  assert.equal(pinned.manifest.posts[0].slug, 'old-folder');
  assert.equal(pinned.manifest.posts[0].relativeUrl, '/en/old-folder/');

  await writeFile(source, `---
id: 01K00000000000000000000000
title: Intentional rename
allowPublishedSlugChange: true
publishAfterDate: 2026-06-01
language: en
---
Body
`);
  const changed = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.deepEqual(changed.results[0].errors, []);
  assert.ok(changed.results[0].warnings.some((warning) => /not a true 301/.test(warning)));
  assert.equal(changed.manifest.posts[0].slug, 'example');
  assert.deepEqual(changed.manifest.redirects, [{
    id: '01K00000000000000000000000',
    language: 'en',
    relativeUrl: '/en/old-folder/',
    pageUrl: 'https://example.com/en/old-folder/',
    targetUrl: 'https://example.com/en/example/'
  }]);
});

test('emits a tombstone only for a language that previously deployed', async () => {
  const root = await fixture(`---
id: 01K00000000000000000000000
title: English
publishAfterDate: 2026-06-01
language: en
---
English
`);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  timezone: UTC
hosting:
  canonicalBaseUrl: https://example.com
  pathPrefix: /
`);
  await writeFile(path.join(root, 'content', 'posts', 'example', 'index.fr.md'), `---
id: 01K00000000000000000000000
title: French
publishAfterDate: 2026-06-02
deleteDate: 2026-06-03
language: fr
---
French
`);
  await mkdir(path.join(root, '.gala'), { recursive: true });
  const statePath = path.join(root, '.gala', 'publication-state.yml');
  await writeFile(statePath, `schemaVersion: 1
posts:
  - id: 01K00000000000000000000000
    slug: example
    languages:
      en:
        firstPublishedOn: 2026-06-01
`);

  const neverPublished = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.deepEqual(neverPublished.manifest.posts.map(({ language }) => language), ['en']);

  await writeFile(statePath, `schemaVersion: 1
posts:
  - id: 01K00000000000000000000000
    slug: example
    languages:
      en:
        firstPublishedOn: 2026-06-01
      fr:
        firstPublishedOn: 2026-06-02
`);
  const previouslyPublished = await regenerateBuildManifest({ root, today: '2026-06-15' });
  assert.deepEqual(
    previouslyPublished.manifest.posts.map(({ language, publicationState }) => [language, publicationState]),
    [['en', 'published'], ['fr', 'tombstoned']]
  );
});
