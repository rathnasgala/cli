import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { githubApi } from '../api/github.js';
import { UsageError } from '../cli/args.js';
import { galaCredential } from './gala.js';
import { githubCredential } from './github.js';
import { credentialDirectory, readCredential } from './store.js';

const PROFILE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const STORE_VERSION = '2';

export function requireProfileName(value) {
  if (typeof value !== 'string' || !PROFILE.test(value)) {
    throw new UsageError('Account profile names use lowercase letters, numbers and single hyphens.');
  }
  return value;
}

export function profilePaths(name, { root = credentialDirectory() } = {}) {
  const safe = requireProfileName(name);
  const directory = path.join(root, 'profiles', safe);
  return {
    directory,
    metadata: path.join(directory, 'profile.json'),
    gala: path.join(directory, 'gala.json'),
    github: path.join(directory, 'github.json'),
    active: path.join(root, 'active-profile'),
  };
}

export async function addProfile({
  terminal,
  apiBaseUrl,
  root = credentialDirectory(),
  galaSignIn = galaCredential,
  githubSignIn = githubCredential,
  galaLookup = async (credential) => galaApi({
    baseUrl: credential.apiBaseUrl,
    token: credential.accessToken,
  }).profile(),
  githubLookup = async (credential) => githubApi(credential.accessToken).viewer(),
}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const pending = await mkdtemp(path.join(root, '.pending-profile-'));
  await chmod(pending, 0o700);
  const pendingPaths = {
    gala: path.join(pending, 'gala.json'),
    github: path.join(pending, 'github.json'),
  };
  try {
    const gala = await galaSignIn({ terminal, apiBaseUrl, target: pendingPaths.gala });
    const galaIdentity = await galaLookup(gala);
    const github = await githubSignIn({ terminal, target: pendingPaths.github });
    const githubLogin = await githubLookup(github);
    if (typeof githubLogin !== 'string') {
      throw new UsageError('GitHub did not return an account username.');
    }
    const name = requireProfileName(githubLogin.toLowerCase());
    const metadata = normalizeMetadata({ schemaVersion: 2, name, gala: galaIdentity, githubLogin });
    await atomicJson(path.join(pending, 'profile.json'), metadata);
    await prepareStore(root);
    const paths = profilePaths(name, { root });
    await rm(paths.directory, { recursive: true, force: true });
    await rename(pending, paths.directory);
    await setActiveProfile(name, { root });
    return { metadata, gala, github };
  } catch (failure) {
    await rm(pending, { recursive: true, force: true });
    throw failure;
  }
}

export async function listProfiles({ root = credentialDirectory() } = {}) {
  const directory = path.join(root, 'profiles');
  let names;
  try {
    names = await readdir(directory);
  } catch (failure) {
    if (failure?.code === 'ENOENT') return [];
    throw failure;
  }
  const active = await activeProfile({ root });
  const profiles = [];
  for (const name of names.sort()) {
    try {
      const metadata = JSON.parse(await readFile(profilePaths(name, { root }).metadata, 'utf8'));
      profiles.push({ ...normalizeMetadata(metadata), active: name === active });
    } catch (failure) {
      if (failure?.code !== 'ENOENT' && !(failure instanceof SyntaxError)) throw failure;
    }
  }
  return profiles;
}

export async function useProfile(name, { root = credentialDirectory() } = {}) {
  const selected = await readProfile(name, { root });
  await setActiveProfile(selected.metadata.name, { root });
  return selected.metadata;
}

export async function removeProfile(name, { root = credentialDirectory() } = {}) {
  const paths = profilePaths(name, { root });
  try {
    const metadata = await stat(paths.directory);
    if (!metadata.isDirectory()) throw new UsageError(`Account profile ${name} is unavailable.`);
  } catch (failure) {
    if (failure?.code === 'ENOENT') throw new UsageError(`Account profile ${name} does not exist.`);
    throw failure;
  }
  await rm(paths.directory, { recursive: true });
  if (await activeProfile({ root }) === name) await rm(paths.active, { force: true });
}

export async function selectedProfile({ name, root = credentialDirectory() } = {}) {
  const selected = name == null ? await activeProfile({ root }) : requireProfileName(name);
  if (selected == null) {
    throw new UsageError('No account profile is active. Run `npx --yes @rathnasgala/cli@latest auth add`.');
  }
  return readProfile(selected, { root });
}

export async function activeProfile({ root = credentialDirectory() } = {}) {
  try {
    const value = (await readFile(path.join(root, 'active-profile'), 'utf8')).trim();
    return requireProfileName(value);
  } catch (failure) {
    if (failure?.code === 'ENOENT') return null;
    throw failure;
  }
}

async function readProfile(name, { root }) {
  const paths = profilePaths(name, { root });
  let metadata;
  try {
    metadata = normalizeMetadata(JSON.parse(await readFile(paths.metadata, 'utf8')));
  } catch (failure) {
    if (failure?.code === 'ENOENT' || failure instanceof SyntaxError) {
      throw new UsageError(`Account profile ${name} is incomplete; remove it and add it again.`);
    }
    throw failure;
  }
  const [gala, github] = await Promise.all([readCredential(paths.gala), readCredential(paths.github)]);
  if (gala == null || github == null) {
    throw new UsageError(
      `Account profile ${name} has expired; run \`npx --yes @rathnasgala/cli@latest auth add\` to sign in again.`
    );
  }
  return { metadata, gala, github };
}

async function setActiveProfile(name, { root }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await atomicText(path.join(root, 'active-profile'), `${requireProfileName(name)}\n`);
}

function normalizeMetadata(value) {
  const name = requireProfileName(value?.name);
  if (value?.schemaVersion !== 2) {
    throw new UsageError(`Account profile ${name} has an unsupported format.`);
  }
  const userId = value?.gala?.userId;
  const email = value?.gala?.email;
  const displayName = value?.gala?.displayName;
  const githubLogin = value?.githubLogin;
  if (typeof userId !== 'string' || !ULID.test(userId)
      || typeof email !== 'string' || email === ''
      || typeof displayName !== 'string' || displayName === ''
      || typeof githubLogin !== 'string' || githubLogin === '') {
    throw new UsageError(`Account profile ${name} has invalid identity metadata.`);
  }
  if (githubLogin.toLowerCase() !== name) {
    throw new UsageError(`Account profile ${name} does not match its GitHub identity.`);
  }
  return { schemaVersion: 2, name, gala: { userId, email, displayName }, githubLogin };
}

async function prepareStore(root) {
  const version = path.join(root, 'profile-store-version');
  const current = await readFile(version, 'utf8').catch((failure) => {
    if (failure?.code === 'ENOENT') return null;
    throw failure;
  });
  if (current?.trim() !== STORE_VERSION) {
    await rm(path.join(root, 'profiles'), { recursive: true, force: true });
    await rm(path.join(root, 'active-profile'), { force: true });
    await rm(path.join(root, 'credentials.json'), { force: true });
    await rm(path.join(root, 'github-credentials.json'), { force: true });
    await atomicText(version, `${STORE_VERSION}\n`);
  }
  await mkdir(path.join(root, 'profiles'), { recursive: true, mode: 0o700 });
}

async function atomicJson(target, value) {
  return atomicText(target, `${JSON.stringify(value)}\n`);
}

async function atomicText(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}
