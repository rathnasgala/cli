import { describeHttpFailure } from './http-failure.js';
const GITHUB_API_VERSION = '2026-03-10';

/**
 * The GitHub account the stored credential belongs to.
 *
 * `scaffold` used to make the writer pass `--owner`, which is a value the token already knows and
 * they can only get wrong. The credential file holds the token and its scopes and nothing else, so
 * this is a live lookup rather than something cached at `auth github` time — a login can be
 * changed, and a stale one would create the repository under a name that no longer exists.
 */
export async function resolveGithubLogin({ accessToken, fetchImpl = fetch }) {
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new TypeError('accessToken is required');
  }
  const response = await fetchImpl('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'x-github-api-version': GITHUB_API_VERSION
    }
  });
  if (!response.ok) throw new Error(await describeHttpFailure(response, 'GitHub account lookup'));
  const payload = await response.json();
  const login = payload?.login;
  // The same shape `scaffold` demands of `--owner`. Refusing here beats a confusing failure four
  // API calls later.
  if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new TypeError('GitHub returned an unusable account login');
  }
  return login;
}
