import assert from 'node:assert/strict';
import test from 'node:test';

import { parseScaffoldOptions } from '../src/scaffold-options.js';

test('parses high-level design options without OS-specific behavior', () => {
  assert.deepEqual(
    parseScaffoldOptions(['--theme', 'editorial', '--palette', 'default', '--radius', 'soft']),
    { theme: 'editorial', palette: 'default', radius: 'soft' }
  );
});

test('rejects an option without a value', () => {
  assert.throws(() => parseScaffoldOptions(['--layout']), /Missing value for --layout/);
});

test('parses locale, site, repeated sharing, and social profile options', () => {
  assert.deepEqual(parseScaffoldOptions([
    '--site-name', 'Engineering Notes',
    '--author', 'Anand',
    '--language', 'fr-ca',
    '--timezone', 'America/Toronto',
    '--share-target', 'linkedin',
    '--share-target', 'email',
    '--social-profile', 'github=https://github.com/example',
    '--social-profile', 'mastodon=https://social.example/@author'
  ]), {
    siteName: 'Engineering Notes',
    siteAuthor: 'Anand',
    defaultLanguage: 'fr-ca',
    timezone: 'America/Toronto',
    shareTargets: ['linkedin', 'email'],
    socialProfiles: [
      'github=https://github.com/example',
      'mastodon=https://social.example/@author'
    ]
  });
});

test('rejects missing repeated-option values', () => {
  assert.throws(() => parseScaffoldOptions(['--share-target']), /Missing value/);
  assert.throws(() => parseScaffoldOptions(['--social-profile', '--theme', 'editorial']), /Missing value/);
});
