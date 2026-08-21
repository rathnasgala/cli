import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { GITHUB_APP_INSTALL_URL, prepareScaffold, repositoryNameFrom } from '../src/scaffold-preflight.js';

const gala = { accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' };
const github = { accessToken: 'github-token', scopes: ['repo', 'workflow'] };

function stubs(overrides = {}) {
  return {
    readGala: async () => gala,
    readGithub: async () => github,
    resolveLogin: async () => 'rathnasgala',
    resolveInstallation: async () => 153144989,
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
    githubInstallationId: 153144989
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
      input.showScopeWarning({ explanation: 'repo and workflow are required' });
      input.showInstructions({ verificationUri: 'https://github.com/login/device', userCode: 'WXYZ-9876' });
      githubStored = true;
    },
    resolveLogin: async () => 'rathnasgala',
    resolveInstallation: async () => 153144989,
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

test('walks the writer through installing the App, then continues with the id it finds', async () => {
  const messages = [];
  const questions = [];
  let installed = false;

  const prepared = await prepareScaffold({
    repository: 'field-notes',
    notify: (message) => messages.push(message),
    ask: async (question) => { questions.push(question); installed = true; return ''; },
    ...stubs({ resolveInstallation: async () => (installed ? 153144989 : null) })
  });

  assert.equal(prepared.githubInstallationId, 153144989);
  assert.equal(questions.length, 1);
  assert.ok(messages.some((message) => message.includes(GITHUB_APP_INSTALL_URL)));
  assert.ok(messages.some((message) => message.includes('not installed')));
});

test('gives up with an actionable message rather than looping forever', async () => {
  const questions = [];
  await assert.rejects(
    prepareScaffold({
      repository: 'field-notes',
      installAttempts: 2,
      ask: async (question) => { questions.push(question); return ''; },
      ...stubs({ resolveInstallation: async () => null })
    }),
    (error) => error.message.includes(GITHUB_APP_INSTALL_URL) && /still does not cover/.test(error.message)
  );
  assert.equal(questions.length, 2);
});

test('never blocks on a prompt when there is no terminal to answer it', async () => {
  await assert.rejects(
    prepareScaffold({ repository: 'field-notes', ...stubs({ resolveInstallation: async () => null }) }),
    /Install it at .*installations\/new .*--installation-id/s
  );
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
