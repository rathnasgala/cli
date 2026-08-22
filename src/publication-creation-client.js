/**
 * Creates the publication repository the way the browser editor does.
 *
 * The CLI used to call `POST /repos/{template}/generate` itself. That is a second, worse
 * implementation of something the API already does and does properly:
 *
 *  - it tries the template, then falls back to creating an empty repository and seeding it, then
 *    reports that the writer must do it by hand — the CLI's single attempt had no rung below it;
 *  - it waits for the Gala App installation to actually reach the new repository before calling it
 *    ready, which is why repositories the CLI created never appeared in the web UI;
 *  - it returns the installation id, so registration cannot disagree with creation about which
 *    installation owns the repository.
 *
 * One implementation, exercised by both clients, is the only way the two stay in step.
 */
import { describeHttpFailure } from './http-failure.js';
import { exchangeGithubAuthorization } from './site-registration-client.js';

export async function createPublication({
  apiBaseUrl = 'https://api.gala67.com',
  galaAccessToken,
  githubAccessToken,
  name,
  fetchImpl = fetch,
  authorize = exchangeGithubAuthorization,
  notify = () => {},
  ask,
  openUrl = () => false,
  shareAttempts = 3,
  selfLogin
}) {
  let created = false;
  let shareUrl = 'https://github.com/settings/installations';
  let repositoryOwner = selfLogin ?? '';
  let repositoryName = name;
  for (let attempt = 0; attempt < Math.max(1, shareAttempts); attempt += 1) {
    const result = await requestPublication({
      apiBaseUrl, galaAccessToken, githubAccessToken, name, fetchImpl, authorize
    });
    if (result.ready) return result.publication;

    /*
     * The repository exists with the right content; the App installation simply cannot see it,
     * because it is scoped to selected repositories rather than all of them. Sharing it is a click,
     * and asking again then returns READY — the server short-circuits on a repository it can
     * already see. The browser editor recovers the same way; without this the CLI dead-ends on a
     * state that is one click from working.
     *
     * After the first attempt the repository exists, so a further refusal reports UNSUPPORTED
     * rather than NEEDS_SHARING — the same situation under a different name.
     */
    const shareable = result.status === 'NEEDS_SHARING' || created;
    if (result.status === 'NEEDS_SHARING') {
      created = true;
      shareUrl = installationSettingsUrl(result.installationId, result.owner, selfLogin);
      repositoryName = result.repository ?? repositoryName;
      repositoryOwner = result.owner ?? repositoryOwner;
    }
    if (!shareable || typeof ask !== 'function') throw result.failure;

    notify(`${repositoryOwner}/${repositoryName} was created, but the Gala GitHub App cannot reach `
      + 'it yet — its installation covers only selected repositories, which is the right way to '
      + 'have it. Add this one repository to the installation; nothing else needs granting.');
    notify(`${openUrl(shareUrl) ? 'Opened' : 'Open'} ${shareUrl}`);
    await ask('Press enter once the App can access that repository. ');
  }
  throw new Error(
    `The Gala GitHub App still cannot reach ${repositoryOwner}/${repositoryName}. Add that `
    + `repository to the installation at ${shareUrl}, then run scaffold again.`
  );
}

/**
 * The page that grants one repository, rather than the list of every app ever installed.
 *
 * GitHub keeps user and organisation installation settings on different paths, and only the caller
 * knows which this is: the created owner differing from the token's own account means the
 * installation lives on an organisation.
 */
export function installationSettingsUrl(installationId, owner, selfLogin) {
  const generic = 'https://github.com/settings/installations';
  if (!Number.isSafeInteger(Number(installationId)) || Number(installationId) <= 0) return generic;
  const isOrganization = typeof owner === 'string' && typeof selfLogin === 'string'
    && owner.toLowerCase() !== selfLogin.toLowerCase();
  return isOrganization
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}

async function requestPublication({
  apiBaseUrl, galaAccessToken, githubAccessToken, name, fetchImpl, authorize
}) {
  const authorization = await authorize({
    apiBaseUrl, galaAccessToken, githubAccessToken, fetchImpl
  });
  const response = await fetchImpl(`${String(apiBaseUrl).replace(/\/$/, '')}/v1/auth/github/publications`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${galaAccessToken}`,
      'content-type': 'application/json',
      'GitHub-Authorization': authorization
    },
    body: JSON.stringify({ name })
  });
  if (!response.ok) throw new Error(await describeHttpFailure(response, 'Gala publication creation'));

  const payload = await response.json();
  const status = payload?.status;
  const owner = payload?.owner;
  const repository = payload?.name;

  if (status !== 'READY') {
    return {
      ready: false, status, owner, repository,
      // Carried even though the repository is not in the installation yet: it is what makes the
      // grant a deep link rather than a hunt.
      installationId: payload?.installationId,
      failure: new Error(
        `Gala could not create the publication repository (${payload?.outcome ?? status}). `
        + 'Give the Gala GitHub App access to it at https://github.com/settings/installations, or '
        + 'create it from https://github.com/rathnasgala/site-template yourself and run scaffold '
        + 'with --empty-existing-repository.'
      )
    };
  }
  if (typeof owner !== 'string' || typeof repository !== 'string') {
    throw new TypeError('Gala publication creation returned no repository identity');
  }
  const installationId = Number(payload?.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new TypeError('Gala publication creation returned no installation');
  }

  return { ready: true, status, owner, repository, publication: Object.freeze({
    owner,
    repository,
    installationId,
    outcome: payload?.outcome ?? null,
    // The server names the repository it actually made, which may differ from what was asked for.
    fullName: `${owner}/${repository}`,
    cloneUrl: `https://github.com/${owner}/${repository}.git`
  }) };
}
