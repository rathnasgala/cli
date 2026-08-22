import path from 'node:path';

import { authenticateGala } from './auth-command.js';
import { authenticateGithub } from './github-auth-command.js';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { resolveGithubLogin } from './github-identity.js';
import { galaCredentialAccepted } from './gala-credential-health.js';
import { openInBrowser } from './open-browser.js';
import { forgetGalaCredential } from './gala-credential-store.js';

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
  openUrl = openInBrowser,
  readGala = readGalaCredential,
  readGithub = readGithubCredential,
  credentialAccepted = galaCredentialAccepted,
  forgetGala = forgetGalaCredential,
  signInGala = authenticateGala,
  signInGithub = authenticateGithub,
  resolveLogin = resolveGithubLogin,
  apiBaseUrl = DEFAULT_API_BASE_URL
} = {}) {
  const gala = await ensureGala({
    apiBaseUrl, notify, readGala, signInGala, credentialAccepted, forgetGala, openUrl
  });
  const github = await ensureGithub({ notify, readGithub, signInGithub, openUrl });

  const resolvedOwner = owner ?? await resolveLogin({ accessToken: github.accessToken });

  const resolvedRepository = repository
    ?? (target == null ? null : path.basename(path.resolve(cwd, target)))
    ?? repositoryNameFrom(siteName)
    ?? await askForRepository(ask);

  // `--target ./` is the common case and means "here", so the repository takes its name from the
  // directory the writer is standing in. Everywhere else the repository names its own folder.
  const resolvedTarget = target ?? `./${resolvedRepository}`;

  /*
   * No installation lookup. The id is an internal GitHub identifier for an App the server owns, and
   * nothing here can discover it reliably: a GitHub App token could list installations and the CLI
   * cannot hold one, while the repository inventory only carries the id once a repository exists —
   * which, in the flow that creates the first repository, is never. The server resolves it during
   * registration. `--installation-id` still overrides, for an account with several.
   */
  return Object.freeze({
    owner: resolvedOwner,
    repository: resolvedRepository,
    target: resolvedTarget,
    githubInstallationId: githubInstallationId ?? null
  });
}

/**
 * A missing, expired or refused credential is a step to take, not an error to report.
 *
 * The stored file is checked against the server before anything depends on it, because a
 * credential that parses and has not expired can still be one the API refuses — and finding that
 * out four calls later, as an opaque 401 from whichever endpoint got there first, is how a
 * "sign in again" turned into a stack trace.
 */
async function ensureGala({
  apiBaseUrl, notify, readGala, signInGala, credentialAccepted, forgetGala, openUrl
}) {
  let stored = null;
  try {
    stored = await readGala();
  } catch {
    stored = null;
  }

  if (stored != null) {
    const base = stored.apiBaseUrl ?? apiBaseUrl;
    if (await credentialAccepted({ apiBaseUrl: base, accessToken: stored.accessToken })) {
      return stored;
    }
    // Leaving it on disk would make every later command repeat this discovery.
    await forgetGala();
    notify('Your Gala sign-in is no longer valid.');
  }

  notify('Signing in to Gala.');
  await signInGala({
    apiBaseUrl,
    showInstructions: ({ verificationUri, userCode }) =>
      notify(`${openUrl(verificationUri) ? 'Opened' : 'Open'} ${verificationUri}\nEnter code: ${userCode}`)
  });
  return readGala();
}

async function ensureGithub({ notify, readGithub, signInGithub, openUrl }) {
  try {
    return await readGithub();
  } catch {
    notify('Signing in to GitHub.');
    await signInGithub({
      showScopeWarning: ({ explanation }) => notify(`GitHub authorization: ${explanation}`),
      showInstructions: ({ verificationUri, userCode }) =>
        notify(`${openUrl(verificationUri) ? 'Opened' : 'Open'} ${verificationUri}\nEnter code: ${userCode}`)
    });
    return readGithub();
  }
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
