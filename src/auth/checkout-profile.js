import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../cli/args.js';
import { readPublication } from '../publication.js';
import { listProfiles, requireProfileName } from './profiles.js';

const FILENAME = 'gala-account-profile';

export async function bindCheckoutProfile(root, name) {
  const gitDirectory = path.join(path.resolve(root), '.git');
  const metadata = await stat(gitDirectory).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error('Cannot bind the account profile because this is not a standard Git checkout.');
  }
  const target = path.join(gitDirectory, FILENAME);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${requireProfileName(name)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}

export async function checkoutProfile(root) {
  try {
    return requireProfileName((await readFile(
      path.join(path.resolve(root), '.git', FILENAME), 'utf8'
    )).trim());
  } catch (failure) {
    if (failure?.code === 'ENOENT') return null;
    throw failure;
  }
}

export async function accountForCommand(options, root, { terminal, profilesRoot } = {}) {
  const explicit = options.value('account');
  const bound = await checkoutProfile(root);
  if (explicit != null) {
    const selected = await resolveProfileSelector(explicit, profilesRoot);
    if (bound != null && bound !== selected) {
      throw new UsageError(
        `This checkout belongs to account profile ${bound}; --account ${selected} cannot override it.`
      );
    }
    if (bound == null) await bindIfCheckout(root, selected);
    return selected;
  }
  if (bound != null) return bound;

  const profiles = await listProfiles(profilesRoot == null ? {} : { root: profilesRoot });
  if (profiles.length === 0) {
    throw new UsageError('No account profile exists. Run `npx --yes @rathnasgala/cli@latest auth add`.');
  }
  const publication = await readPublication(root);
  const repositoryOwner = typeof publication?.repository === 'string'
    ? publication.repository.split('/', 1)[0]?.toLowerCase()
    : null;
  const ownerMatches = repositoryOwner == null ? [] : profiles.filter((profile) =>
    profile.githubLogin.toLowerCase() === repositoryOwner);
  let selected;
  if (ownerMatches.length === 1) selected = ownerMatches[0].name;
  else if (profiles.length === 1) selected = profiles[0].name;
  else {
    if (!terminal?.interactive) {
      throw new UsageError(
        `This repository could use more than one account profile (${profileChoices(profiles)}); pass --account <profile>.`
      );
    }
    const answer = await terminal.ask(`Which account owns this repository? (${profileChoices(profiles)})`);
    selected = resolveFromProfiles(answer, profiles);
  }
  await bindIfCheckout(root, selected);
  terminal?.note(`Using account profile ${selected} for this repository.`);
  return selected;
}

async function resolveProfileSelector(value, profilesRoot) {
  const profiles = await listProfiles(profilesRoot == null ? {} : { root: profilesRoot });
  return resolveFromProfiles(value, profiles);
}

function resolveFromProfiles(value, profiles) {
  const selector = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  const matches = profiles.filter(({ name, githubLogin, gala: identity }) => name === selector
    || githubLogin.toLowerCase() === selector
    || identity.email.toLowerCase() === selector);
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1) {
    throw new UsageError(`Account ${value} matches more than one profile; use one of: ${profileChoices(matches)}.`);
  }
  throw new UsageError(`Account ${value} is not configured; use one of: ${profileChoices(profiles)}.`);
}

function profileChoices(profiles) {
  return profiles.map(({ name, githubLogin, gala: identity }) =>
    `${name} (GitHub @${githubLogin}, Gala ${identity.email})`).join(', ');
}

async function bindIfCheckout(root, selected) {
  const metadata = await stat(path.join(path.resolve(root), '.git')).catch(() => null);
  if (metadata?.isDirectory()) await bindCheckoutProfile(root, selected);
}
