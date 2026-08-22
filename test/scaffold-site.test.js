import assert from 'node:assert/strict';
import test from 'node:test';

import { scaffoldSite } from '../src/scaffold-site.js';

test('orchestrates template, API-owned secret provisioning, workflow, and repository variable in order', async () => {
  const calls = [];
  const result = await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989,
    siteOptions: { siteName: 'Smoke', timezone: 'America/Los_Angeles' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com/' }),
    // Repository creation goes through the API now — the same call the browser editor makes —
    // which also reports the installation that owns the result.
    createRepository: async (input) => { calls.push(['create', input]); return {
      owner: 'rathnasgala', repository: 'smoke01', installationId: 153144989, outcome: 'CREATED_FROM_TEMPLATE',
      fullName: 'rathnasgala/smoke01', cloneUrl: 'https://github.com/rathnasgala/smoke01.git'
    }; },
    awaitContent: async (input) => { calls.push(['await-content', input]); },
    clone: async (input) => { calls.push(['clone', input]); return '/tmp/smoke01'; },
    configure: async (root, options) => { calls.push(['configure', root, options]); return {
      site: { timezone: 'America/Los_Angeles' }
    }; },
    register: async (input) => { calls.push(['register', input]); return {
      siteId: '01K00000000000000000000000', siteSecret: 'one-time-secret',
      canonicalBaseUrl: 'https://rathnasgala.github.io', pathPrefix: '/smoke01'
    }; },
    sync: async (root) => { calls.push(['sync', root]); return '0123456789abcdef0123456789abcdef01234567'; },
    installVariable: async (input) => calls.push(['variable', input]),
    commit: async (root) => { calls.push(['commit', root]); },
    provisionPages: async (input) => { calls.push(['pages', input]); return { created: true }; }
  });

  /*
   * The configuration commit goes up before registration and nothing goes up after it: the server
   * writes site.config.yml and the publish workflow during register, and a CLI commit afterwards
   * produced a second Publish run that collided with the first one's deployment record.
   */
  assert.deepEqual(calls.map(([name]) => name), [
    'create', 'await-content', 'clone', 'configure', 'commit', 'register', 'variable', 'sync'
  ]);
  // Content is awaited before the clone, or the checkout is empty.
  assert.ok(calls.findIndex(([name]) => name === 'await-content')
    < calls.findIndex(([name]) => name === 'clone'));
  const registered = calls.find(([name]) => name === 'register')[1];
  assert.equal(registered.topology, 'PROVIDER_DEFAULT');
  assert.equal(registered.canonicalBaseUrl, 'https://rathnasgala.github.io');
  assert.match(registered.idempotencyKey, /^scaffold-[0-9a-f]{64}$/);
  // The installation the API reported at creation is the one registration is told about.
  assert.equal(registered.githubInstallationId, 153144989);
  assert.deepEqual(calls.find(([name]) => name === 'variable')[1], {
    owner: 'rathnasgala', repository: 'smoke01', accessToken: 'github-token',
    variableName: 'GALA_API_BASE_URL', variableValue: 'https://api.gala67.com/'
  });
  assert.equal(result.commitSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(result.pages, null, 'the provider default needs no Pages call');
  assert.equal(result.siteId, '01K00000000000000000000000');
});

test('registers and provisions an explicit custom-domain root without provider-path inference', async () => {
  const calls = [];
  await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke02', target: '/tmp/smoke02',
    githubInstallationId: 153144989, resumeExistingCheckout: true,
    topology: 'custom-domain', canonicalBaseUrl: 'https://SMOKE.gala67.com/',
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    verifyCheckout: async ({ root }) => root,
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async (input) => { calls.push(['register', input]); return {
      siteId: '01K00000000000000000000000', siteSecret: 'secret',
      canonicalBaseUrl: 'https://smoke.gala67.com', pathPrefix: '/'
    }; },
    sync: async () => '0123456789abcdef0123456789abcdef01234567',
    installVariable: async () => {},
    commit: async () => {},
    provisionPages: async (input) => { calls.push(['pages', input]); return { created: true }; }
  });
  const registered = calls.find(([name]) => name === 'register')[1];
  assert.equal(registered.topology, 'CUSTOM_DOMAIN');
  // The host is normalised to lower case and the trailing slash dropped before it is registered.
  assert.equal(registered.canonicalBaseUrl, 'https://smoke.gala67.com');
  // The publish workflow is the server's to write now, so `--action-ref` no longer applies to
  // scaffold; `gala workflow --action-ref` still regenerates it deliberately.
  assert.equal(calls.find(([name]) => name === 'pages')[1].customDomain, 'smoke.gala67.com');
});

test('rejects incomplete or ambiguous topology inputs before reading credentials', async () => {
  for (const input of [
    { topology: 'custom-domain' },
    { topology: 'provider-default', canonicalBaseUrl: 'https://smoke.gala67.com' },
    { topology: 'unknown' },
    { topology: 'custom-domain', canonicalBaseUrl: 'https://smoke.gala67.com/blog' }
  ]) {
    let credentialRead = false;
    await assert.rejects(scaffoldSite({
      owner: 'rathnasgala', repository: 'smoke02', target: '/tmp/smoke02',
      githubInstallationId: 153144989, siteOptions: {}, ...input,
      readGithub: async () => { credentialRead = true; return {}; },
      readGala: async () => { credentialRead = true; return {}; }
    }), /topology|canonical/i);
    assert.equal(credentialRead, false);
  }
});

test('fails before repository creation when either credential is unavailable', async () => {
  let generated = false;
  await assert.rejects(scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989, siteOptions: {},
    readGithub: async () => { throw new Error('GitHub authentication is missing'); },
    readGala: async () => ({ accessToken: 'gala', apiBaseUrl: 'https://api.gala67.com' }),
    generate: async () => { generated = true; }
  }), /GitHub authentication is missing/);
  assert.equal(generated, false);
});

test('adopts only a verified empty repository by repointing the local template clone', async () => {
  const calls = [];
  await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989, emptyExistingRepository: true,
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    verifyEmpty: async (input) => calls.push(['verify-empty', input]),
    generate: async () => { throw new Error('must not generate over existing repository'); },
    clone: async (input) => { calls.push(['clone', input]); return '/tmp/smoke01'; },
    setOrigin: async (input) => calls.push(['origin', input]),
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async () => ({ siteId: '01K00000000000000000000000', siteSecret: 'secret', canonicalBaseUrl: 'https://rathnasgala.github.io', pathPrefix: '/smoke01' }),
    sync: async () => '0123456789abcdef0123456789abcdef01234567', writeWorkflow: async () => {},
    installVariable: async () => {}, commit: async () => '0123456789abcdef0123456789abcdef01234567',
    provisionPages: async () => ({ created: true })
  });
  assert.deepEqual(calls.map(([name]) => name), ['verify-empty', 'clone', 'origin']);
  assert.equal(calls[1][1].cloneUrl, 'https://github.com/rathnasgala/site-template.git');
});

test('resumes only a checkout whose origin matches the requested repository', async () => {
  const calls = [];
  await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989, resumeExistingCheckout: true,
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    verifyCheckout: async (input) => { calls.push(['verify-checkout', input]); return input.root; },
    generate: async () => { throw new Error('must not generate while resuming'); },
    clone: async () => { throw new Error('must not clone while resuming'); },
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async () => ({ siteId: '01K00000000000000000000000', siteSecret: 'secret', canonicalBaseUrl: 'https://rathnasgala.github.io', pathPrefix: '/smoke01' }),
    sync: async () => '0123456789abcdef0123456789abcdef01234567', writeWorkflow: async () => {},
    installVariable: async () => {}, commit: async () => '0123456789abcdef0123456789abcdef01234567',
    provisionPages: async () => ({ created: true })
  });
  assert.deepEqual(calls, [['verify-checkout', {
    root: '/tmp/smoke01', owner: 'rathnasgala', repository: 'smoke01'
  }]]);
});

test('build-only scaffolding never provisions GitHub Pages', async () => {
  const result = await scaffoldSite({
    owner: 'rathnasgala', repository: 'hosted-blog', target: '/tmp/hosted-blog',
    githubInstallationId: 153144989, resumeExistingCheckout: true, buildMode: 'build-only',
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    verifyCheckout: async ({ root }) => root,
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async () => ({
      siteId: '01K00000000000000000000000', siteSecret: 'secret',
      canonicalBaseUrl: 'https://rathnasgala.github.io', pathPrefix: '/hosted-blog'
    }),
    sync: async () => '0123456789abcdef0123456789abcdef01234567', writeWorkflow: async () => {},
    installVariable: async () => {},
    commit: async () => {},
    provisionPages: async () => { throw new Error('build-only must not provision Pages'); }
  });
  assert.equal(result.pages, null);
});

test('rejects conflicting initial-adoption and resume modes before mutation', async () => {
  await assert.rejects(scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989, emptyExistingRepository: true, resumeExistingCheckout: true,
    siteOptions: {}, readGithub: async () => ({ accessToken: 'github-token' }),
    readGala: async () => ({ accessToken: 'gala-token' })
  }), /mutually exclusive/);
});

test('the server decides the owner and name, and everything downstream follows it', async () => {
  /*
   * The API creates under the account the Gala App installation belongs to, which is not always the
   * account behind the writer's OAuth token — an installation on an organisation they belong to
   * gives a different owner. Deriving the canonical URL, idempotency key, registration and Pages
   * target from the local guess registers a publication against a repository that does not exist.
   */
  const calls = [];
  const result = await scaffoldSite({
    owner: 'guessed-user', repository: 'guessed-name', target: '/tmp/actual',
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    createRepository: async () => ({
      owner: 'actual-org', repository: 'actual-name', installationId: 155579156,
      outcome: 'CREATED_FROM_TEMPLATE',
      fullName: 'actual-org/actual-name',
      cloneUrl: 'https://github.com/actual-org/actual-name.git'
    }),
    awaitContent: async (input) => calls.push(['await-content', input]),
    clone: async (input) => { calls.push(['clone', input]); return '/tmp/actual'; },
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async (input) => { calls.push(['register', input]); return {
      siteId: '01K00000000000000000000000', siteSecret: 's',
      canonicalBaseUrl: 'https://actual-org.github.io', pathPrefix: '/actual-name'
    }; },
    sync: async () => '0123456789abcdef0123456789abcdef01234567',
    installVariable: async (input) => calls.push(['variable', input]),
    commit: async () => {},
    provisionPages: async (input) => { calls.push(['pages', input]); return { created: true }; }
  });

  assert.ok(!calls.some(([name]) => name === 'pages'),
    'a provider-default publication is served by classic Pages without an API call');
  const register = calls.find(([name]) => name === 'register')[1];
  assert.equal(register.repositoryOwner, 'actual-org');
  assert.equal(register.repositoryName, 'actual-name');
  // The provider-default origin is derived from the real owner, not the guess.
  assert.equal(register.canonicalBaseUrl, 'https://actual-org.github.io');
  assert.equal(register.githubInstallationId, 155579156);

  assert.equal(calls.find(([name]) => name === 'variable')[1].owner, 'actual-org');
  assert.equal(calls.find(([name]) => name === 'clone')[1].cloneUrl,
    'https://github.com/actual-org/actual-name.git');
  assert.equal(result.fullName, 'actual-org/actual-name');
});

test('a custom domain still configures Pages, because nothing else will', async () => {
  /*
   * The provider default needs no Pages call: publishing creates a `gh-pages` branch and GitHub
   * turns on classic Pages by itself — every scaffold was serving before this step ran, including
   * runs that failed before reaching it. All the step cost there was ten minutes of polling and a
   * reported failure for a live publication.
   *
   * A custom domain is the opposite: classic Pages will not point itself at someone's own hostname.
   */
  const calls = [];
  await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke02', target: '/tmp/smoke02',
    resumeExistingCheckout: true,
    topology: 'custom-domain', canonicalBaseUrl: 'https://smoke.gala67.com',
    siteOptions: { timezone: 'UTC' },
    readGithub: async () => ({ accessToken: 'ghu_token' }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com' }),
    verifyCheckout: async () => '/tmp/smoke02',
    configure: async () => ({ site: { timezone: 'UTC' } }),
    register: async () => ({
      siteId: '01K00000000000000000000000', siteSecret: 's',
      canonicalBaseUrl: 'https://smoke.gala67.com', pathPrefix: '/'
    }),
    sync: async () => '0123456789abcdef0123456789abcdef01234567',
    installVariable: async () => {},
    commit: async () => {},
    provisionPages: async (input) => { calls.push(input); return { created: true }; }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].customDomain, 'smoke.gala67.com');
  assert.equal(calls[0].owner, 'rathnasgala');
});
