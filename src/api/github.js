import { requestJson } from './http.js';

/**
 * GitHub, as the Gala App.
 *
 * The CLI holds a GitHub App user token, not an OAuth App token. That single difference is what
 * separates this from v0: an App token can list installations, is not blocked by an organisation's
 * OAuth App restrictions, and reaches only repositories the App has been given — rather than every
 * repository the writer can see, which is what `repo` scope meant.
 */
const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

export function githubApi(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': API_VERSION
  };

  return {
    /** The account behind the token. Works for every token type and needs no permission. */
    async viewer() {
      const body = await requestJson(`${API}/user`, { action: 'GitHub account lookup', headers });
      const login = body?.login;
      if (typeof login !== 'string' || login === '') {
        throw new TypeError('GitHub returned an unusable account login');
      }
      return login;
    },

    /**
     * Whether a repository has content yet.
     *
     * Creating a repository is asynchronous: GitHub answers with a clone URL before the template
     * lands. Cloning into that window produces an empty checkout and a missing site.config.yml —
     * a confusing error about a file the template certainly contains. `size` is not usable as the
     * signal; GitHub still reported 0 for a repository that already had commits.
     */
    async hasContent(owner, repository) {
      const branches = await requestJson(
        `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=1`,
        { action: 'GitHub branch lookup', headers }
      );
      return Array.isArray(branches) && branches.length > 0;
    },

    setVariable(owner, repository, name, value) {
      const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables`;
      return requestJson(`${base}/${encodeURIComponent(name)}`, {
        action: 'GitHub repository variable',
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name, value })
      }).catch(() => requestJson(base, {
        action: 'GitHub repository variable',
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name, value })
      }));
    }
  };
}
