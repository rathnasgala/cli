import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';

import { configureSite } from '../src/configure-site.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-configure-'));
  await writeFile(path.join(root, 'site.config.yml'), stringify({
    schemaVersion: 1,
    site: { name: 'Preserved', defaultLanguage: 'en', timezone: 'UTC' },
    design: { theme: 'editorial', palette: 'default' },
    sharing: { targets: [], socialProfiles: {} }
  }));
  await writeFile(path.join(root, 'custom.css'), 'author override');
  return root;
}

test('applies high-level design options while preserving other configuration', async () => {
  const root = await fixture();
  const config = await configureSite(root, {
    theme: 'portfolio',
    palette: 'ocean',
    typography: 'humanist',
    spacing: 'compact',
    radius: 'sharp',
    density: 'compact',
    motion: 'none',
    componentStyle: 'outlined'
  });

  assert.equal(config.site.name, 'Preserved');
  assert.equal(config.design.theme, 'portfolio');
  assert.equal(config.design.palette, 'ocean');
  assert.equal(await readFile(path.join(root, 'custom.css'), 'utf8'), 'author override');
});

test('writes validated site, locale, sharing, and social profile settings', async () => {
  const root = await fixture();
  const config = await configureSite(root, {
    siteName: 'Engineering Notes',
    siteAuthor: 'Anand',
    defaultLanguage: 'fr-ca',
    timezone: 'America/Toronto',
    shareTargets: ['linkedin', 'email', 'linkedin'],
    socialProfiles: [
      'github=https://github.com/example#ignored',
      'mastodon=https://social.example/@author'
    ]
  });

  assert.equal(config.site.name, 'Engineering Notes');
  assert.equal(config.site.author, 'Anand');
  assert.equal(config.site.defaultLanguage, 'fr-CA');
  assert.equal(config.site.timezone, 'America/Toronto');
  assert.deepEqual(config.sharing.targets, ['linkedin', 'email']);
  assert.deepEqual(config.sharing.socialProfiles, {
    github: 'https://github.com/example',
    mastodon: 'https://social.example/@author'
  });
});

test('rejects invalid locale, timezone, sharing, and social profile values', async () => {
  const invalid = [
    [{ siteAuthor: ' ' }, /siteAuthor/],
    [{ defaultLanguage: 'not_a_language' }, /BCP-47/],
    [{ timezone: 'Mars/Olympus' }, /IANA/],
    [{ shareTargets: ['facebook'] }, /Unsupported share target/],
    [{ socialProfiles: ['facebook=https://example.com'] }, /Unsupported social profile/],
    [{ socialProfiles: ['github=http://github.com/example'] }, /must use HTTPS/],
    [{ socialProfiles: ['github=https://user:secret@github.com/example'] }, /without credentials/]
  ];

  for (const [options, expected] of invalid) {
    const root = await fixture();
    const before = await readFile(path.join(root, 'site.config.yml'), 'utf8');
    await assert.rejects(() => configureSite(root, options), expected);
    assert.equal(await readFile(path.join(root, 'site.config.yml'), 'utf8'), before);
  }
});

test('rejects unknown options and leaves configuration byte-identical', async () => {
  const root = await fixture();
  const configPath = path.join(root, 'site.config.yml');
  const before = await readFile(configPath, 'utf8');
  await assert.rejects(() => configureSite(root, { unknown: 'value' }), /Unsupported/);
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('refuses a symbolic-link configuration target', async () => {
  const root = await fixture();
  const linkedRoot = await mkdtemp(path.join(tmpdir(), 'gala-configure-link-'));
  await symlink(path.join(root, 'site.config.yml'), path.join(linkedRoot, 'site.config.yml'));
  await assert.rejects(() => configureSite(linkedRoot, { theme: 'other' }), /regular file/);
});
