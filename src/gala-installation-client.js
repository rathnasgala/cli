/**
 * Which Gala GitHub App installation covers this writer's account.
 *
 * The installation ID is an internal GitHub identifier that `scaffold` has to send when it
 * registers a site. Until now the writer supplied it by installing the App, watching GitHub
 * redirect to `https://github.com/settings/installations/153144989`, and copying the number out of
 * the address bar — an internal identifier, read out of a URL, by hand.
 *
 * The Gala API already knows it. `GET /v1/auth/github/repositories` answers with
 * `{ installationId, owner, name, status }` per repository, so the CLI can ask the same service it
 * is about to register with rather than guess. Reaching that endpoint needs the bounded capability
 * from `POST /v1/auth/github/device-authorizations`, which is bound to the Gala user and takes the
 * GitHub token the CLI already holds.
 */
function endpoint(apiBaseUrl, path) {
  return `${String(apiBaseUrl).replace(/\/$/, '')}${path}`;
}

export async function exchangeGithubAuthorization({
  apiBaseUrl, galaAccessToken, githubAccessToken, fetchImpl = fetch
}) {
  const response = await fetchImpl(endpoint(apiBaseUrl, '/v1/auth/github/device-authorizations'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${galaAccessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ accessToken: githubAccessToken })
  });
  if (!response.ok) {
    throw new Error(`GitHub authorization exchange failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (typeof payload?.authorization !== 'string') {
    throw new TypeError('GitHub authorization exchange returned no capability');
  }
  return payload.authorization;
}

export async function listAuthorizedRepositories({ apiBaseUrl, authorization, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint(apiBaseUrl, '/v1/auth/github/repositories'), {
    headers: { accept: 'application/json', 'GitHub-Authorization': authorization }
  });
  if (!response.ok) {
    throw new Error(`Authorized repository lookup failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new TypeError('Authorized repository lookup returned no list');
  return payload;
}

/**
 * Returns the installation covering `owner`, or null when the App is not installed there.
 *
 * An installation belongs to an account, not to one repository, so any repository the App can
 * already see under that owner carries the id the new one will use. Null is an ordinary answer —
 * it means "not installed yet" — and the caller turns it into an instruction, not an error.
 */
export async function resolveInstallationId({
  apiBaseUrl, galaAccessToken, githubAccessToken, owner, fetchImpl = fetch,
  exchange = exchangeGithubAuthorization, list = listAuthorizedRepositories
}) {
  const authorization = await exchange({
    apiBaseUrl, galaAccessToken, githubAccessToken, fetchImpl
  });
  const repositories = await list({ apiBaseUrl, authorization, fetchImpl });
  const wanted = String(owner).toLowerCase();
  for (const repository of repositories) {
    if (String(repository?.owner).toLowerCase() !== wanted) continue;
    const installationId = Number(repository?.installationId);
    if (Number.isSafeInteger(installationId) && installationId > 0) return installationId;
  }
  return null;
}
