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
  if (response.status === 409) {
    // The API distinguishes "the App is not installed on this account" from "your credential is
    // finished". Only the first is something the writer can fix in a browser, so it is signalled
    // rather than thrown: the caller offers the installation page and waits.
    return null;
  }
  if (response.status === 401) {
    // Either credential can be the one at fault and the caller cannot tell them apart, so say so
    // rather than printing a status code the writer has no way to interpret.
    throw new Error(
      'Gala refused the GitHub authorization. Run `npx --yes @rathnasgala/cli@latest auth` and '
      + '`auth github` again, then retry.'
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub authorization exchange failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (typeof payload?.authorization !== 'string') {
    throw new TypeError('GitHub authorization exchange returned no capability');
  }
  return payload.authorization;
}

/**
 * Both credentials are required, and they are not interchangeable.
 *
 * The endpoint is `.authenticated()` and its handler takes the Gala principal, so the bearer says
 * who is asking; `GitHub-Authorization` is the short-lived capability that says what they may see.
 * Sending only the capability gets a bare 401 from the security filter, before any handler runs —
 * which reads as "your GitHub authorization was refused" and is nothing of the kind.
 */
export async function listAuthorizedRepositories({
  apiBaseUrl, authorization, galaAccessToken, fetchImpl = fetch
}) {
  const response = await fetchImpl(endpoint(apiBaseUrl, '/v1/auth/github/repositories'), {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${galaAccessToken}`,
      'GitHub-Authorization': authorization
    }
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
  // null means the App is not installed yet, which the caller turns into an instruction.
  if (authorization == null) return null;
  const repositories = await list({ apiBaseUrl, authorization, galaAccessToken, fetchImpl });
  const wanted = String(owner).toLowerCase();
  for (const repository of repositories) {
    if (String(repository?.owner).toLowerCase() !== wanted) continue;
    const installationId = Number(repository?.installationId);
    if (Number.isSafeInteger(installationId) && installationId > 0) return installationId;
  }
  return null;
}
