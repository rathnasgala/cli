import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addProfile,
  authenticatedProfile,
  activeProfile,
  listProfiles,
  profilePaths,
  removeProfile,
  requireProfileName,
  selectedProfile,
  useProfile,
} from '../src/auth/profiles.js';
import {
  accountForCommand,
  bindCheckoutProfile,
  checkoutProfile,
} from '../src/auth/checkout-profile.js';
import { writeCredential } from '../src/auth/store.js';

const future = '2099-01-01T00:00:00.000Z';
const options = (account) => ({ value: (name) => name === 'account' ? account : undefined });
const scratch = () => mkdtemp(path.join(tmpdir(), 'gala-profiles-'));

async function seed(root, name, {
  email = `${name}@example.com`, githubLogin = name, galaToken = `gala-${name}`,
  githubToken = `github-${name}`, galaExpiry = future, githubExpiry = future,
  schemaVersion = 2,
} = {}) {
  const paths = profilePaths(name, { root });
  await mkdir(paths.directory, { recursive: true });
  await writeCredential(paths.gala, { accessToken: galaToken, expiresAt: galaExpiry,
    apiBaseUrl: 'https://api.gala67.test' });
  await writeCredential(paths.github, { accessToken: githubToken, expiresAt: githubExpiry });
  await writeFile(paths.metadata, JSON.stringify({
    schemaVersion, name,
    gala: { userId: '01M00000000000000000000001',
      email, displayName: name },
    githubLogin,
  }));
  return paths;
}

test('accepts safe stable profile names and rejects traversal, spaces and ambiguous punctuation', () => {
  for (const name of ['personal', 'forum-2', 'rathna-test']) assert.equal(requireProfileName(name), name);
  for (const name of ['', '../other', 'Two', 'two_words', 'two--words', 'two words', '.']) {
    assert.throws(() => requireProfileName(name), /profile names/);
  }
});

test('an explicitly selected profile returns its own Gala and GitHub credentials as one unit', async () => {
  const root = await scratch();
  await seed(root, 'rathnastest', { email: 'anandchakru.forum@gmail.com' });
  const profile = await selectedProfile({ name: 'rathnastest', root });
  assert.equal(profile.metadata.gala.email, 'anandchakru.forum@gmail.com');
  assert.equal(profile.metadata.githubLogin, 'rathnastest');
  assert.equal(profile.gala.accessToken, 'gala-rathnastest');
  assert.equal(profile.github.accessToken, 'github-rathnastest');
});

test('the production incident cannot be reconstructed by selecting one Gala and another GitHub account', async () => {
  const root = await scratch();
  await seed(root, 'rfai8me', { email: 'rfai8me@gmail.com' });
  await seed(root, 'rathnastest', { email: 'anandchakru.forum@gmail.com' });
  const rfai = await selectedProfile({ name: 'rfai8me', root });
  const forum = await selectedProfile({ name: 'rathnastest', root });
  assert.deepEqual([rfai.metadata.gala.email, rfai.metadata.githubLogin],
    ['rfai8me@gmail.com', 'rfai8me']);
  assert.deepEqual([forum.metadata.gala.email, forum.metadata.githubLogin],
    ['anandchakru.forum@gmail.com', 'rathnastest']);
  assert.notEqual(rfai.github.accessToken, forum.github.accessToken);
});

test('use changes only the active profile pointer and preserves both complete pairs', async () => {
  const root = await scratch();
  await seed(root, 'one');
  await seed(root, 'two');
  await useProfile('one', { root });
  assert.equal(await activeProfile({ root }), 'one');
  await useProfile('two', { root });
  assert.equal(await activeProfile({ root }), 'two');
  assert.equal((await selectedProfile({ name: 'one', root })).github.accessToken, 'github-one');
});

test('add derives the profile name from GitHub and activates the stored identity pair', async () => {
  const root = await scratch();
  const profile = await addProfile({
    root, apiBaseUrl: 'https://api.gala67.test', terminal: {},
    galaSignIn: async ({ target }) => {
      const value = { accessToken: 'gala-forum', apiBaseUrl: 'https://api.gala67.test', expiresAt: future };
      await writeCredential(target, value);
      return value;
    },
    galaLookup: async () => ({ userId: '01M00000000000000000000001',
      email: 'anandchakru.forum@gmail.com', displayName: 'Anand Chakru' }),
    githubSignIn: async ({ target }) => {
      const value = { accessToken: 'github-forum', expiresAt: future };
      await writeCredential(target, value);
      return value;
    },
    githubLookup: async () => 'rathnastest',
  });
  assert.deepEqual([profile.metadata.gala.email, profile.metadata.githubLogin],
    ['anandchakru.forum@gmail.com', 'rathnastest']);
  assert.equal(profile.metadata.name, 'rathnastest');
  assert.equal(await activeProfile({ root }), 'rathnastest');
});

test('the first add removes obsolete alias profiles and records the new store version', async () => {
  const root = await scratch();
  const obsolete = await seed(root, 'forum', { schemaVersion: 1, githubLogin: 'rathnastest' });
  const legacyGala = path.join(root, 'credentials.json');
  const legacyGitHub = path.join(root, 'github-credentials.json');
  await writeFile(legacyGala, 'obsolete');
  await writeFile(legacyGitHub, 'obsolete');
  const profile = await addProfile({
    root, terminal: {},
    galaSignIn: async ({ target }) => {
      const value = { accessToken: 'gala-new', expiresAt: future };
      await writeCredential(target, value);
      return value;
    },
    galaLookup: async () => ({ userId: '01M00000000000000000000001',
      email: 'anandchakru.forum@gmail.com', displayName: 'Anand' }),
    githubSignIn: async ({ target }) => {
      const value = { accessToken: 'github-new', expiresAt: future };
      await writeCredential(target, value);
      return value;
    },
    githubLookup: async () => 'rathnastest',
  });
  await assert.rejects(stat(obsolete.directory), { code: 'ENOENT' });
  await assert.rejects(stat(legacyGala), { code: 'ENOENT' });
  await assert.rejects(stat(legacyGitHub), { code: 'ENOENT' });
  assert.equal(profile.metadata.name, 'rathnastest');
  assert.equal((await readFile(path.join(root, 'profile-store-version'), 'utf8')).trim(), '2');
});

test('add cleans up a partial profile when either identity lookup fails', async () => {
  const root = await scratch();
  const paths = profilePaths('broken', { root });
  await assert.rejects(addProfile({
    root, terminal: {},
    galaSignIn: async ({ target }) => {
      const value = { accessToken: 'gala', expiresAt: future };
      await writeCredential(target, value);
      return value;
    },
    galaLookup: async () => { throw new Error('identity unavailable'); },
  }), /identity unavailable/);
  await assert.rejects(stat(paths.directory), { code: 'ENOENT' });
});

test('later adds preserve other new-format profiles and replace only the same GitHub login', async () => {
  const root = await scratch();
  await writeFile(path.join(root, 'profile-store-version'), '2\n');
  const existing = await seed(root, 'rfai8me');
  const signIn = async ({ target }) => {
    const value = { accessToken: 'fresh', expiresAt: future };
    await writeCredential(target, value);
    return value;
  };
  await addProfile({
    root, terminal: {}, galaSignIn: signIn, githubSignIn: signIn,
    galaLookup: async () => ({ userId: '01M00000000000000000000001',
      email: 'forum@example.com', displayName: 'Forum' }),
    githubLookup: async () => 'RathnasTest',
  });
  assert.ok((await stat(existing.directory)).isDirectory());
  assert.equal(await activeProfile({ root }), 'rathnastest');
});

test('selection fails closed when no profile is active', async () => {
  await assert.rejects(selectedProfile({ root: await scratch() }), /No account profile is active/);
});

test('selection fails closed when either half of a profile is expired', async () => {
  const root = await scratch();
  await seed(root, 'gala-expired', { galaExpiry: '2000-01-01T00:00:00.000Z' });
  await seed(root, 'github-expired', { githubExpiry: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(selectedProfile({ name: 'gala-expired', root }), /expired/);
  await assert.rejects(selectedProfile({ name: 'github-expired', root }), /expired/);
});

test('an interactive command refreshes an expired profile and resumes with the same identity', async () => {
  const root = await scratch();
  await seed(root, 'owner', { galaExpiry: '2000-01-01T00:00:00.000Z' });
  const messages = [];
  const terminal = { interactive: true, step: (value) => messages.push(value),
    done: (value) => messages.push(value) };
  const refreshed = await authenticatedProfile({
    name: 'owner', root, terminal,
    reauthenticate: async () => ({
      metadata: { name: 'owner' }, gala: { accessToken: 'fresh-gala' },
      github: { accessToken: 'fresh-github' },
    }),
  });
  assert.equal(refreshed.github.accessToken, 'fresh-github');
  assert.deepEqual(messages, [
    'Account profile owner expired; signing in again',
    'Signed in again as owner',
  ]);
});

test('automatic refresh refuses a different identity and never prompts without a terminal', async () => {
  const root = await scratch();
  await seed(root, 'owner', { githubExpiry: '2000-01-01T00:00:00.000Z' });
  await assert.rejects(authenticatedProfile({ name: 'owner', root }), /has expired/);
  await assert.rejects(authenticatedProfile({
    name: 'owner', root,
    terminal: { interactive: true, step() {}, done() {} },
    reauthenticate: async () => ({ metadata: { name: 'other' }, gala: {}, github: {} }),
  }), /uses account profile owner, but you signed in as other/);
});

test('selection rejects missing, corrupt, incomplete and old metadata', async () => {
  const root = await scratch();
  const missing = profilePaths('missing', { root });
  await mkdir(missing.directory, { recursive: true });
  await assert.rejects(selectedProfile({ name: 'missing', root }), /incomplete/);
  const corrupt = await seed(root, 'corrupt');
  await writeFile(corrupt.metadata, '{');
  await assert.rejects(selectedProfile({ name: 'corrupt', root }), /incomplete/);
  await seed(root, 'old', { schemaVersion: 0 });
  await assert.rejects(selectedProfile({ name: 'old', root }), /unsupported format/);
  const incomplete = await seed(root, 'incomplete');
  const value = JSON.parse(await readFile(incomplete.metadata, 'utf8'));
  delete value.githubLogin;
  await writeFile(incomplete.metadata, JSON.stringify(value));
  await assert.rejects(selectedProfile({ name: 'incomplete', root }), /invalid identity metadata/);
});

test('list is deterministic, identifies the active profile and ignores incomplete entries', async () => {
  const root = await scratch();
  await seed(root, 'zeta');
  await seed(root, 'alpha');
  await mkdir(profilePaths('broken', { root }).directory, { recursive: true });
  await useProfile('zeta', { root });
  const profiles = await listProfiles({ root });
  assert.deepEqual(profiles.map(({ name }) => name), ['alpha', 'zeta']);
  assert.deepEqual(profiles.map(({ active }) => active), [false, true]);
});

test('remove deletes exactly one profile and clears the pointer only when it was active', async () => {
  const root = await scratch();
  await seed(root, 'one');
  await seed(root, 'two');
  await useProfile('one', { root });
  await removeProfile('two', { root });
  assert.equal(await activeProfile({ root }), 'one');
  await assert.rejects(selectedProfile({ name: 'two', root }), /incomplete/);
  await removeProfile('one', { root });
  assert.equal(await activeProfile({ root }), null);
});

test('remove can recover corrupt and expired profiles, but never guesses a missing target', async () => {
  const root = await scratch();
  const corrupt = await seed(root, 'corrupt');
  await writeFile(corrupt.metadata, '{');
  await removeProfile('corrupt', { root });
  const expired = await seed(root, 'expired', { galaExpiry: '2000-01-01T00:00:00.000Z' });
  await removeProfile('expired', { root });
  await assert.rejects(stat(expired.directory), { code: 'ENOENT' });
  await assert.rejects(removeProfile('missing', { root }), /does not exist/);
});

test('active profile and checkout binding files are private', async () => {
  const root = await scratch();
  await seed(root, 'one');
  await useProfile('one', { root });
  assert.equal((await stat(profilePaths('one', { root }).active)).mode & 0o777, 0o600);
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  await bindCheckoutProfile(checkout, 'one');
  assert.equal((await stat(path.join(checkout, '.git', 'gala-account-profile'))).mode & 0o777, 0o600);
});

test('checkout binding survives active-profile switches and controls subsequent commands', async () => {
  const root = await scratch();
  await mkdir(path.join(root, '.git'));
  await bindCheckoutProfile(root, 'forum');
  assert.equal(await checkoutProfile(root), 'forum');
  assert.equal(await accountForCommand(options(undefined), root), 'forum');
});

test('an explicit command profile cannot override a different checkout binding', async () => {
  const root = await scratch();
  await mkdir(path.join(root, '.git'));
  await bindCheckoutProfile(root, 'forum');
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'forum');
  await seed(profilesRoot, 'rfai');
  await assert.rejects(
    accountForCommand(options('rfai'), root, { profilesRoot }),
    /belongs to account profile forum/
  );
  assert.equal(await checkoutProfile(root), 'forum');
});

test('an explicit command profile may repeat the checkout binding or select an unbound checkout', async () => {
  const bound = await scratch();
  await mkdir(path.join(bound, '.git'));
  await bindCheckoutProfile(bound, 'forum');
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'forum');
  await seed(profilesRoot, 'rfai');
  assert.equal(await accountForCommand(options('forum'), bound, { profilesRoot }), 'forum');
  const unbound = await scratch();
  await mkdir(path.join(unbound, '.git'));
  assert.equal(await accountForCommand(options('rfai'), unbound, { profilesRoot }), 'rfai');
  assert.equal(await checkoutProfile(unbound), 'rfai');
});

test('an unbound checkout with one profile selects and remembers it', async () => {
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'only');
  assert.equal(await accountForCommand(options(undefined), checkout, { profilesRoot }), 'only');
  assert.equal(await checkoutProfile(checkout), 'only');
});

test('an unbound checkout selects the profile matching its configured repository owner', async () => {
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  await writeFile(path.join(checkout, 'site.config.yml'), 'site:\n  repository: owner/publication\nhosting:\n  canonicalBaseUrl: https://owner.github.io\n');
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'other');
  await seed(profilesRoot, 'owner');
  assert.equal(await accountForCommand(options(undefined), checkout, { profilesRoot }), 'owner');
  assert.equal(await checkoutProfile(checkout), 'owner');
});

test('an ambiguous checkout asks with identifiable choices and remembers the answer', async () => {
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'one', { email: 'one@gala.test' });
  await seed(profilesRoot, 'two', { email: 'two@gala.test' });
  let question;
  const terminal = {
    interactive: true,
    ask: async (value) => { question = value; return 'two@gala.test'; },
    note() {},
  };
  assert.equal(await accountForCommand(options(undefined), checkout, { terminal, profilesRoot }), 'two');
  assert.match(question, /one \(GitHub @one, Gala one@gala\.test\)/);
  assert.match(question, /two \(GitHub @two, Gala two@gala\.test\)/);
  assert.equal(await checkoutProfile(checkout), 'two');
});

test('account accepts a GitHub handle or Gala email and rejects only unknown choices', async () => {
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'owner', { email: 'writer@gala.test', githubLogin: 'Owner' });
  for (const selector of ['@Owner', 'writer@gala.test']) {
    const checkout = await scratch();
    await mkdir(path.join(checkout, '.git'));
    assert.equal(await accountForCommand(options(selector), checkout, { profilesRoot }), 'owner');
  }
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  await assert.rejects(
    accountForCommand(options('missing'), checkout, { profilesRoot }),
    /not configured; use one of: owner/
  );
});

test('a noninteractive ambiguous checkout names the valid account choices', async () => {
  const checkout = await scratch();
  await mkdir(path.join(checkout, '.git'));
  const profilesRoot = await scratch();
  await seed(profilesRoot, 'one');
  await seed(profilesRoot, 'two');
  await assert.rejects(
    accountForCommand(options(undefined), checkout, { profilesRoot }),
    /more than one account profile.*one.*two/
  );
});

test('binding refuses nonstandard or missing Git metadata rather than writing into the publication', async () => {
  const root = await scratch();
  await assert.rejects(bindCheckoutProfile(root, 'forum'), /not a standard Git checkout/);
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await assert.rejects(bindCheckoutProfile(root, 'forum'), /not a standard Git checkout/);
});
