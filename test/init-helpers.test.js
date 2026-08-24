import assert from 'node:assert/strict';
import test from 'node:test';

import { installationUrl, publicationAccount, slugify } from '../src/commands/init.js';

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

test('selects the personal installation without depending on GitHub list order', async () => {
  const api = {
    githubInstallationAccounts: async () => ({
      installationUrl: 'https://github.com/apps/gala67-app/installations/new',
      accounts: [
        { installationId: 84, login: 'writers-room', organization: true },
        { installationId: 42, login: 'ada', organization: false },
      ],
    }),
  };

  assert.deepEqual(await publicationAccount({ terminal: {}, api, capability: 'proof' }),
    { installationId: 42, login: 'ada', organization: false });
});

test('asks instead of guessing between multiple organization installations', async () => {
  const api = {
    githubInstallationAccounts: async () => ({
      installationUrl: 'https://github.com/apps/gala67-app/installations/new',
      accounts: [
        { installationId: 84, login: 'writers-room', organization: true },
        { installationId: 85, login: 'editors-room', organization: true },
      ],
    }),
  };
  const terminal = { ask: async () => 'editors-room' };

  assert.equal((await publicationAccount({ terminal, api, capability: 'proof' })).installationId, 85);
});

test('reports the exact installation route when authorization has no installation', async () => {
  const api = {
    githubInstallationAccounts: async () => ({
      installationUrl: 'https://github.com/apps/gala67-app/installations/new',
      accounts: [],
    }),
  };

  await assert.rejects(
    publicationAccount({ terminal: {}, api, capability: 'proof' }),
    /https:\/\/github\.com\/apps\/gala67-app\/installations\/new/,
  );
});
