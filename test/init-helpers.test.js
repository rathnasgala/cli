import assert from 'node:assert/strict';
import test from 'node:test';

import { installationUrl, slugify } from '../src/commands/init.js';

test('turns what a writer types into something GitHub accepts as a repository name', () => {
  assert.equal(slugify('Field Notes'), 'field-notes');
  assert.equal(slugify('  Small Hours!  '), 'small-hours');
  assert.equal(slugify('Notes 2026'), 'notes-2026');
  // Nothing usable is left, so the caller asks again rather than creating `---`.
  assert.equal(slugify('***'), null);
  assert.equal(slugify(''), null);
  assert.equal(slugify(undefined), null);
});

test('links to the one installation that needs the grant, on the right settings path', () => {
  /*
   * GitHub offers no API to add a repository to an installation on the writer's behalf — it is
   * documented as classic-PAT-only — so this always ends in a click, and the only thing worth
   * optimising is whether that click is one link away or a hunt through every app they have ever
   * installed. User and organisation installations live on different paths.
   */
  assert.equal(installationUrl(155579156, 'ada', 'ada'),
    'https://github.com/settings/installations/155579156');
  assert.equal(installationUrl(4568309, 'acme', 'ada'),
    'https://github.com/organizations/acme/settings/installations/4568309');
  for (const id of [null, undefined, 0, -1, 'nope']) {
    assert.equal(installationUrl(id, 'acme', 'ada'), 'https://github.com/settings/installations');
  }
});
