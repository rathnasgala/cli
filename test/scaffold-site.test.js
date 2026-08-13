import assert from 'node:assert/strict';
import test from 'node:test';

import { scaffoldSite } from '../src/scaffold-site.js';

test('orchestrates template, registration, workflow, and one-time secret installation in order', async () => {
  const calls = [];
  const result = await scaffoldSite({
    owner: 'rathnasgala', repository: 'smoke01', target: '/tmp/smoke01',
    githubInstallationId: 153144989,
    siteOptions: { siteName: 'Smoke', timezone: 'America/Los_Angeles' },
    readGithub: async () => ({ accessToken: 'github-token', scopes: ['repo', 'workflow'] }),
    readGala: async () => ({ accessToken: 'gala-token', apiBaseUrl: 'https://api.gala67.com/' }),
    generate: async (input) => { calls.push(['generate', input]); return {
      fullName: 'rathnasgala/smoke01', cloneUrl: 'https://github.com/rathnasgala/smoke01.git'
    }; },
    clone: async (input) => { calls.push(['clone', input]); return '/tmp/smoke01'; },
    configure: async (root, options) => { calls.push(['configure', root, options]); return {
      site: { timezone: 'America/Los_Angeles' }
    }; },
    register: async (input) => { calls.push(['register', input]); return {
      siteId: '01K00000000000000000000000', siteSecret: 'one-time-secret',
      canonicalBaseUrl: 'https://rathnasgala.github.io/smoke01/'
    }; },
    finalize: async (...input) => calls.push(['finalize', ...input]),
    writeWorkflow: async (input) => calls.push(['workflow', input]),
    installSecret: async (input) => calls.push(['secret', input]),
    installVariable: async (input) => calls.push(['variable', input]),
    commit: async (root) => { calls.push(['commit', root]); return '0123456789abcdef0123456789abcdef01234567'; },
    provisionPages: async (input) => { calls.push(['pages', input]); return { created: true }; }
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'generate', 'clone', 'configure', 'register', 'finalize', 'workflow', 'secret', 'variable', 'commit', 'pages'
  ]);
  assert.equal(calls[3][1].topology, 'PROVIDER_DEFAULT');
  assert.equal(calls[3][1].canonicalBaseUrl, 'https://rathnasgala.github.io/smoke01/');
  assert.match(calls[3][1].idempotencyKey, /^scaffold-[0-9a-f]{64}$/);
  assert.equal(calls[6][1].secretName, 'GALA_SITE_SECRET');
  assert.deepEqual(calls[7][1], {
    owner: 'rathnasgala', repository: 'smoke01', accessToken: 'github-token',
    variableName: 'GALA_API_BASE_URL', variableValue: 'https://api.gala67.com/'
  });
  assert.equal(calls[9][1].commitSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(result.siteId, '01K00000000000000000000000');
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
    register: async () => ({ siteId: '01K00000000000000000000000', siteSecret: 'secret', canonicalBaseUrl: 'https://rathnasgala.github.io/smoke01/' }),
    finalize: async () => {}, writeWorkflow: async () => {}, installSecret: async () => {},
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
    register: async () => ({ siteId: '01K00000000000000000000000', siteSecret: 'secret', canonicalBaseUrl: 'https://rathnasgala.github.io/smoke01/' }),
    finalize: async () => {}, writeWorkflow: async () => {}, installSecret: async () => {},
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
      canonicalBaseUrl: 'https://rathnasgala.github.io/hosted-blog/'
    }),
    finalize: async () => {}, writeWorkflow: async () => {}, installSecret: async () => {},
    installVariable: async () => {},
    commit: async () => '0123456789abcdef0123456789abcdef01234567',
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
