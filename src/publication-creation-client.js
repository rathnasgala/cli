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
  authorize = exchangeGithubAuthorization
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

  if (status === 'NEEDS_SHARING') {
    throw new Error(
      `${owner}/${repository} was created from the template, but the Gala GitHub App cannot reach `
      + 'it yet. Open https://github.com/settings/installations, give the App access to that '
      + 'repository, then run scaffold again with --resume.'
    );
  }
  if (status !== 'READY') {
    throw new Error(
      `Gala could not create the publication repository (${payload?.outcome ?? status}). `
      + 'Create it from https://github.com/rathnasgala/site-template yourself, then run scaffold '
      + 'with --empty-existing-repository.'
    );
  }
  if (typeof owner !== 'string' || typeof repository !== 'string') {
    throw new TypeError('Gala publication creation returned no repository identity');
  }
  const installationId = Number(payload?.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new TypeError('Gala publication creation returned no installation');
  }

  return Object.freeze({
    owner,
    repository,
    installationId,
    outcome: payload?.outcome ?? null,
    // The server names the repository it actually made, which may differ from what was asked for.
    fullName: `${owner}/${repository}`,
    cloneUrl: `https://github.com/${owner}/${repository}.git`
  });
}
