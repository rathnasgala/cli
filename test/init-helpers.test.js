import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectDestination, installationUrl, publicationAccount, slugify } from '../src/commands/init.js';
import { customDomain } from '../src/domain.js';

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

test('installs the GitHub App and resumes the same init when no installation is visible yet', async () => {
  let calls = 0;
  const api = {
    githubInstallationAccounts: async () => ({
      installationUrl: 'https://github.com/apps/gala67-app/installations/new',
      accounts: calls++ === 0
        ? []
        : [{ installationId: 42, login: 'ada', organization: false }],
    }),
  };
  const opened = [];
  const terminal = {
    blank() {},
    step() {},
    note() {},
    openUrl(url) { opened.push(url); },
    waitForEnter: async () => true,
  };

  assert.deepEqual(await publicationAccount({ terminal, api, capability: 'proof' }),
    { installationId: 42, login: 'ada', organization: false });
  assert.deepEqual(opened, ['https://github.com/apps/gala67-app/installations/new']);
  assert.equal(calls, 2);
});

test('stops cleanly when GitHub App installation cannot be completed interactively', async () => {
  const installationUrl = 'https://github.com/apps/gala67-app/installations/new';
  const api = {
    githubInstallationAccounts: async () => ({ installationUrl, accounts: [] }),
  };
  const terminal = {
    blank() {},
    step() {},
    note() {},
    openUrl() {},
    waitForEnter: async () => false,
  };

  await assert.rejects(publicationAccount({ terminal, api, capability: 'proof' }),
    new RegExp(installationUrl.replaceAll('/', '\\/')));
});

test('waits for a completed GitHub App installation to become visible', async () => {
  let calls = 0;
  const pauses = [];
  const api = {
    githubInstallationAccounts: async () => ({
      installationUrl: 'https://github.com/apps/gala67-app/installations/new',
      accounts: calls++ < 3
        ? []
        : [{ installationId: 42, login: 'ada', organization: false }],
    }),
  };
  const terminal = {
    blank() {},
    step() {},
    note() {},
    openUrl() {},
    waitForEnter: async () => true,
  };

  assert.equal((await publicationAccount({
    terminal,
    api,
    capability: 'proof',
    pause: async (milliseconds) => { pauses.push(milliseconds); },
  })).installationId, 42);
  assert.equal(calls, 4);
  assert.deepEqual(pauses, [1000, 1000]);
});

test('fails after a completed installation remains unavailable through bounded retries', async () => {
  let calls = 0;
  const api = {
    githubInstallationAccounts: async () => {
      calls += 1;
      return {
        installationUrl: 'https://github.com/apps/gala67-app/installations/new',
        accounts: [],
      };
    },
  };
  const terminal = {
    blank() {},
    step() {},
    note() {},
    openUrl() {},
    waitForEnter: async () => true,
  };

  await assert.rejects(publicationAccount({
    terminal,
    api,
    capability: 'proof',
    pause: async () => {},
  }), /still cannot see a GitHub App installation/);
  assert.equal(calls, 6);
});

test('uses only an empty destination or an empty zero-history git repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-init-'));
  assert.equal(await inspectDestination(path.join(root, 'missing')), 'missing');

  const empty = path.join(root, 'empty');
  await mkdir(empty);
  assert.equal(await inspectDestination(empty), 'empty');

  const unborn = path.join(root, 'unborn');
  await mkdir(path.join(unborn, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(unborn, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(await inspectDestination(unborn), 'empty-git');

  await writeFile(path.join(unborn, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40));
  await assert.rejects(inspectDestination(unborn), /empty destination directory/);

  const otherHistory = path.join(root, 'other-history');
  await mkdir(path.join(otherHistory, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(otherHistory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(otherHistory, '.git', 'refs', 'heads', 'old'), 'b'.repeat(40));
  await assert.rejects(inspectDestination(otherHistory), /empty destination directory/);

  const occupied = path.join(root, 'occupied');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'notes.md'), 'not empty');
  await assert.rejects(inspectDestination(occupied), /empty destination directory/);
});

test('accepts only custom domains GitHub Pages can secure', () => {
  assert.deepEqual(customDomain('Blog.Example.com.'), { host: 'blog.example.com' });
  assert.match(customDomain(`a.${'b'.repeat(62)}.example.com`).error, /shorter than 64/);
  assert.match(customDomain('writer.github.io').error, /outside github\.io/);
  assert.match(customDomain('https://blog.example.com/path').error, /without a protocol/);
});
