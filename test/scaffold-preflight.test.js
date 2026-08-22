import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { prepareScaffold, repositoryNameFrom } from '../src/scaffold-preflight.js';

const gala = { accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' };
const github = { accessToken: 'github-token', scopes: ['repo', 'workflow'] };

function stubs(overrides = {}) {
  return {
    readGala: async () => gala,
    readGithub: async () => github,
    resolveLogin: async () => 'rathnasgala',
    openUrl: () => false,
    credentialAccepted: async () => true,
    forgetGala: async () => {},
    ...overrides
  };
}

test('derives owner, repository, target and installation id from nothing but --target', async () => {
  const prepared = await prepareScaffold({
    target: './',
    cwd: path.join(path.sep, 'home', 'ada', 'field-notes'),
    ...stubs()
  });

  assert.deepEqual({ ...prepared }, {
    owner: 'rathnasgala',
    // `--target ./` means "here", so the directory the writer is standing in names the repository.
    repository: 'field-notes',
    target: './',
    githubInstallationId: null
  });
});

test('names the folder after the repository when only --repository is given', async () => {
  const prepared = await prepareScaffold({ repository: 'field-notes', ...stubs() });
  assert.equal(prepared.target, './field-notes');
});

test('falls back to the site name before asking, and slugifies it for GitHub', async () => {
  let asked = 0;
  const prepared = await prepareScaffold({
    siteName: 'Field Notes & Other Things',
    ask: async () => { asked += 1; return 'unused'; },
    ...stubs()
  });

  assert.equal(prepared.repository, 'field-notes-other-things');
  assert.equal(prepared.target, './field-notes-other-things');
  assert.equal(asked, 0);
});

test('asks for a repository name only when there is nothing to derive one from', async () => {
  const questions = [];
  const prepared = await prepareScaffold({
    ask: async (question) => { questions.push(question); return 'Field Notes'; },
    ...stubs()
  });

  assert.equal(questions.length, 1);
  assert.match(questions[0], /called\?/);
  assert.equal(prepared.repository, 'field-notes');
});

test('every derived value stays overridable, and an explicit installation id skips the lookup', async () => {
  let looked = 0;
  const prepared = await prepareScaffold({
    owner: 'someone-else',
    repository: 'explicit-repo',
    target: '/tmp/somewhere',
    githubInstallationId: 999,
    ...stubs({
      resolveLogin: async () => assert.fail('login must not be looked up when --owner is given'),
      resolveInstallation: async () => { looked += 1; return 1; }
    })
  });

  assert.deepEqual({ ...prepared }, {
    owner: 'someone-else',
    repository: 'explicit-repo',
    target: '/tmp/somewhere',
    githubInstallationId: 999
  });
  assert.equal(looked, 0);
});

test('signs in to Gala and GitHub when no credential is stored, then re-reads it', async () => {
  const order = [];
  let galaStored = false;
  let githubStored = false;

  const prepared = await prepareScaffold({
    repository: 'field-notes',
    notify: (message) => order.push(['notify', message]),
    readGala: async () => {
      if (!galaStored) throw new Error('Gala authentication is missing');
      return gala;
    },
    readGithub: async () => {
      if (!githubStored) throw new Error('GitHub authentication is missing');
      return github;
    },
    signInGala: async (input) => {
      order.push(['sign-in-gala', input.apiBaseUrl]);
      input.showInstructions({ verificationUri: 'https://gala/device', userCode: 'ABCD-1234' });
      galaStored = true;
    },
    signInGithub: async (input) => {
      order.push(['sign-in-github']);
      // No scope warning: a GitHub App negotiates no scopes, so there is nothing to warn about.
      input.showInstructions({ verificationUri: 'https://github.com/login/device', userCode: 'WXYZ-9876' });
      githubStored = true;
    },
    resolveLogin: async () => 'rathnasgala',
    openUrl: () => false,
    apiBaseUrl: 'https://api.gala67.com'
  });

  assert.equal(prepared.owner, 'rathnasgala');
  assert.deepEqual(order.filter(([kind]) => kind !== 'notify').map(([kind]) => kind),
    ['sign-in-gala', 'sign-in-github']);
  assert.ok(order.some(([, message]) => String(message).includes('ABCD-1234')));
  assert.ok(order.some(([, message]) => String(message).includes('WXYZ-9876')));
});

test('does not sign in again when both credentials are already stored', async () => {
  await prepareScaffold({
    repository: 'field-notes',
    ...stubs({
      signInGala: async () => assert.fail('Gala sign-in must not repeat'),
      signInGithub: async () => assert.fail('GitHub sign-in must not repeat')
    })
  });
});


test('never blocks on a prompt when there is no terminal to answer it', async () => {
  await assert.rejects(
    prepareScaffold({ ...stubs() }),
    /repository is required; pass --repository or --site-name/
  );
});

test('slugifies site names the way GitHub accepts repository names', () => {
  assert.equal(repositoryNameFrom('Field Notes'), 'field-notes');
  assert.equal(repositoryNameFrom('  Small Hours!  '), 'small-hours');
  assert.equal(repositoryNameFrom('a.b_c-d'), 'a.b_c-d');
  assert.equal(repositoryNameFrom('***'), null);
  assert.equal(repositoryNameFrom(''), null);
  assert.equal(repositoryNameFrom(undefined), null);
});

test('re-authenticates when the stored credential parses and has not expired but the server refuses it', async () => {
  // The exact shape of the failure this replaces: the API stopped issuing `tenant` claims and now
  // rejects tokens that carry one, while the file itself stays well-formed and unexpired for weeks.
  const order = [];
  let dead = true;

  const prepared = await prepareScaffold({
    repository: 'field-notes',
    notify: (message) => order.push(['notify', message]),
    readGala: async () => ({
      accessToken: dead ? 'legacy-token' : 'fresh-token',
      apiBaseUrl: 'https://api.gala67.com'
    }),
    credentialAccepted: async ({ accessToken }) => accessToken !== 'legacy-token',
    forgetGala: async () => order.push(['forget']),
    signInGala: async () => { order.push(['sign-in']); dead = false; },
    readGithub: async () => github,
    resolveLogin: async () => 'rathnasgala',
    resolveInstallation: async () => 153144989
  });

  assert.equal(prepared.owner, 'rathnasgala');
  // Deleted before signing in: leaving a refused token on disk makes every later command
  // rediscover that it is refused.
  assert.deepEqual(order.filter(([kind]) => kind !== 'notify').map(([kind]) => kind),
    ['forget', 'sign-in']);
  assert.ok(order.some(([, message]) => String(message).includes('no longer valid')));
});

test('does not sign in again when the server still accepts the stored credential', async () => {
  await prepareScaffold({
    repository: 'field-notes',
    ...stubs({
      credentialAccepted: async () => true,
      forgetGala: async () => assert.fail('an accepted credential must not be deleted'),
      signInGala: async () => assert.fail('an accepted credential must not trigger a sign-in')
    })
  });
});

test('opens the sign-in pages instead of asking for the URL to be copied', async () => {
  const messages = [];
  const opened = [];
  let galaStored = false;
  let githubStored = false;
  await prepareScaffold({
    repository: 'field-notes',
    notify: (message) => messages.push(message),
    openUrl: (url) => { opened.push(url); return true; },
    // Missing until the sign-in stores one, which is what makes the retry read succeed.
    readGala: async () => {
      if (!galaStored) throw new Error('missing');
      return { accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' };
    },
    readGithub: async () => {
      if (!githubStored) throw new Error('missing');
      return github;
    },
    signInGala: async (input) => {
      input.showInstructions({ verificationUri: 'https://api.gala67.com/v1/auth/device', userCode: 'AAAA-1111' });
      galaStored = true;
    },
    signInGithub: async (input) => {
      input.showInstructions({ verificationUri: 'https://github.com/login/device', userCode: 'BBBB-2222' });
      githubStored = true;
    },
    resolveLogin: async () => 'rathnasgala',
    credentialAccepted: async () => true,
    forgetGala: async () => {}
  });

  assert.deepEqual(opened, [
    'https://api.gala67.com/v1/auth/device',
    'https://github.com/login/device'
  ]);
  // The URL is still printed: it is the thing a writer moves to another device.
  assert.ok(messages.some((m) => m.includes('Opened https://github.com/login/device')));
  assert.ok(messages.some((m) => m.includes('BBBB-2222')));
});

/*
 * The installation-lookup tests that used to live here are gone with the code they covered.
 *
 * `prepareScaffold` derived the installation id from the API's per-repository inventory, which
 * carries it only once a repository exists — and during scaffolding none does. On a fresh account
 * the inventory is empty, so the lookup answered "no installation" and the CLI told the writer to
 * install an App that was already installed, indefinitely. The server resolves the id during
 * registration now; nothing here has to.
 */
test('sends no installation id at all unless one was given explicitly', async () => {
  const derived = await prepareScaffold({ repository: 'field-notes', ...stubs() });
  assert.equal(derived.githubInstallationId, null);

  const explicit = await prepareScaffold({
    repository: 'field-notes', githubInstallationId: 999, ...stubs()
  });
  assert.equal(explicit.githubInstallationId, 999);
});

test('a fresh account with no repositories still gets through preflight', async () => {
  // The reported failure: saranfrog2 had the App installed and owned no repositories, so every
  // attempt reported it as uninstalled. Preflight no longer asks the question.
  const messages = [];
  const prepared = await prepareScaffold({
    repository: 'field-notes',
    notify: (message) => messages.push(message),
    ...stubs({ resolveLogin: async () => 'saranfrog2' })
  });
  assert.equal(prepared.owner, 'saranfrog2');
  assert.ok(!messages.some((message) => /not installed|Still not seeing/.test(message)));
});
