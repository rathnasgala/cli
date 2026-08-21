import path from 'node:path';

import { authenticateGala } from './auth-command.js';
import { authenticateGithub } from './github-auth-command.js';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { resolveGithubLogin } from './github-identity.js';
import { resolveInstallationId } from './gala-installation-client.js';

export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/gala67-app/installations/new';

const DEFAULT_API_BASE_URL = 'https://api.gala67.com';

/**
 * Everything `scaffold` needs, worked out rather than demanded.
 *
 * `scaffold` used to require four values up front — `--owner`, `--repository`, `--target` and
 * `--installation-id` — and it failed outright if `auth` or `auth github` had not been run first,
 * telling the writer to go and run them. Three of those four are derivable and the two sign-ins
 * can simply happen. Every one of them is still accepted as an explicit override; nothing that
 * worked before stops working.
 *
 * The steps are ordered so nothing is created until everything is known: the App installation is
 * confirmed before a repository exists, rather than after, so an interrupted run leaves no
 * half-connected repository behind.
 */
export async function prepareScaffold({
  owner,
  repository,
  target,
  githubInstallationId,
  siteName,
  cwd = process.cwd(),
  notify = () => {},
  ask,
  installUrl = GITHUB_APP_INSTALL_URL,
  installAttempts = 3,
  readGala = readGalaCredential,
  readGithub = readGithubCredential,
  signInGala = authenticateGala,
  signInGithub = authenticateGithub,
  resolveLogin = resolveGithubLogin,
  resolveInstallation = resolveInstallationId,
  apiBaseUrl = DEFAULT_API_BASE_URL
} = {}) {
  const gala = await ensureGala({ apiBaseUrl, notify, readGala, signInGala });
  const github = await ensureGithub({ notify, readGithub, signInGithub });

  const resolvedOwner = owner ?? await resolveLogin({ accessToken: github.accessToken });

  const resolvedRepository = repository
    ?? (target == null ? null : path.basename(path.resolve(cwd, target)))
    ?? repositoryNameFrom(siteName)
    ?? await askForRepository(ask);

  // `--target ./` is the common case and means "here", so the repository takes its name from the
  // directory the writer is standing in. Everywhere else the repository names its own folder.
  const resolvedTarget = target ?? `./${resolvedRepository}`;

  const resolvedInstallation = githubInstallationId
    ?? await ensureInstallation({
      apiBaseUrl: gala.apiBaseUrl ?? apiBaseUrl,
      galaAccessToken: gala.accessToken,
      githubAccessToken: github.accessToken,
      owner: resolvedOwner,
      notify, ask, installUrl, installAttempts, resolveInstallation
    });

  return Object.freeze({
    owner: resolvedOwner,
    repository: resolvedRepository,
    target: resolvedTarget,
    githubInstallationId: resolvedInstallation
  });
}

/** A missing or expired credential is a step to take, not an error to report. */
async function ensureGala({ apiBaseUrl, notify, readGala, signInGala }) {
  try {
    return await readGala();
  } catch {
    notify('Signing in to Gala.');
    await signInGala({
      apiBaseUrl,
      showInstructions: ({ verificationUri, userCode }) =>
        notify(`Open ${verificationUri}\nEnter code: ${userCode}`)
    });
    return readGala();
  }
}

async function ensureGithub({ notify, readGithub, signInGithub }) {
  try {
    return await readGithub();
  } catch {
    notify('Signing in to GitHub.');
    await signInGithub({
      showScopeWarning: ({ explanation }) => notify(`GitHub authorization: ${explanation}`),
      showInstructions: ({ verificationUri, userCode }) =>
        notify(`Open ${verificationUri}\nEnter code: ${userCode}`)
    });
    return readGithub();
  }
}

/**
 * Confirms the Gala GitHub App is installed, walking the writer through installing it if not.
 *
 * This is the step that used to be a manual detour through GitHub's settings to copy a number out
 * of a redirect URL. The loop is what makes it a step rather than a failure: the writer installs
 * the App in the browser, comes back, presses enter, and the run continues.
 */
async function ensureInstallation({
  apiBaseUrl, galaAccessToken, githubAccessToken, owner,
  notify, ask, installUrl, installAttempts, resolveInstallation
}) {
  for (let attempt = 0; attempt < Math.max(1, installAttempts); attempt += 1) {
    const installationId = await resolveInstallation({
      apiBaseUrl, galaAccessToken, githubAccessToken, owner
    });
    if (installationId != null) return installationId;

    if (typeof ask !== 'function') {
      throw new Error(
        `The Gala GitHub App is not installed on ${owner}. Install it at ${installUrl} and run scaffold again, `
        + 'or pass --installation-id explicitly.'
      );
    }
    notify(`The Gala GitHub App is not installed on ${owner} yet.\nOpen ${installUrl}`);
    await ask('Press enter once the App is installed. ');
  }
  throw new Error(
    `The Gala GitHub App still does not cover ${owner}. Install it at ${installUrl}, then run scaffold again.`
  );
}

/** GitHub repository names allow letters, digits, dot, underscore and hyphen, and nothing else. */
export function repositoryNameFrom(siteName) {
  if (typeof siteName !== 'string') return null;
  const slug = siteName
    .trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
}

async function askForRepository(ask) {
  if (typeof ask !== 'function') {
    throw new TypeError('repository is required; pass --repository or --site-name');
  }
  const answer = repositoryNameFrom(await ask('What should the publication repository be called? '));
  if (answer == null) throw new TypeError('A repository name is required');
  return answer;
}
