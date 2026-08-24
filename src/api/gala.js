import { request, requestJson } from './http.js';

/**
 * The Gala API.
 *
 * Only the calls the six commands make. v0 carried a generated client covering the whole surface —
 * comments, reactions, admin, moderation — none of which a CLI ever touches.
 */
export const DEFAULT_API_BASE_URL = 'https://api.gala67.com';

export function galaApi({ baseUrl = DEFAULT_API_BASE_URL, token } = {}) {
  const root = String(baseUrl).replace(/\/$/, '');
  const authorized = (action, extra = {}) => ({
    action,
    ...extra,
    headers: {
      accept: 'application/json',
      ...(token == null ? {} : { authorization: `Bearer ${token}` }),
      ...extra.headers
    }
  });

  return {
    baseUrl: root,

    /** Cheap authenticated call, used to find out whether a stored credential is still accepted. */
    async accepted() {
      try {
        const response = await fetch(`${root}/v1/me/sites`, {
          headers: { accept: 'application/json', authorization: `Bearer ${token}` }
        });
        // 403 means "not an author yet", which is a stage of the product, not a dead credential.
        return response.status !== 401;
      } catch {
        // Offline is not an answer. Forcing a sign-in the writer does not need is worse than
        // letting the real call fail with its own error.
        return true;
      }
    },

    /** Exchanges the GitHub token for the short-lived capability the GitHub-scoped routes require. */
    async githubCapability(githubToken) {
      const body = await requestJson(`${root}/v1/auth/github/device-authorizations`,
        authorized('GitHub authorization', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessToken: githubToken })
        }));
      if (typeof body?.authorization !== 'string') {
        throw new TypeError('GitHub authorization returned no capability');
      }
      return body.authorization;
    },

    /**
     * Creates the publication repository, the same call the browser editor makes.
     *
     * v0 called GitHub's template endpoint itself: a second implementation with no fallback and no
     * wait for the App installation to reach the result, which is why repositories the CLI created
     * never appeared in the web UI.
     */
    createPublication({ capability, name, installationId }) {
      return requestJson(`${root}/v1/auth/github/publications`,
        authorized('Publication creation', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'GitHub-Authorization': capability },
          body: JSON.stringify({ name, installationId })
        }));
    },

    githubInstallationAccounts({ capability }) {
      return requestJson(`${root}/v1/auth/github/accounts`,
        authorized('GitHub installation accounts', {
          headers: { 'GitHub-Authorization': capability }
        }));
    },

    registerSite({ capability, idempotencyKey, repositoryOwner, repositoryName, topology, canonicalBaseUrl }) {
      return requestJson(`${root}/v1/sites`,
        authorized('Site registration', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'GitHub-Authorization': capability,
            'idempotency-key': idempotencyKey
          },
          body: JSON.stringify({ repositoryOwner, repositoryName, topology, canonicalBaseUrl })
        }));
    },

    listPublications() {
      return requestJson(`${root}/v1/me/sites`, authorized('Publication list'));
    },

    /** Not in the OpenAPI document, though the endpoint exists and is public. */
    async signInConfiguration() {
      return requestJson(`${root}/v1/auth/configuration`, { action: 'Sign-in configuration' });
    },

    /*
     * Form-encoded, not JSON. These are RFC 8628 device-flow endpoints and the spec declares them
     * as `application/x-www-form-urlencoded`; sending JSON gets a bare "Authentication is required",
     * which reads as a credential problem and is nothing of the kind.
     */
    async startDeviceAuthorization() {
      return requestJson(`${root}/v1/auth/device/code`, {
        action: 'Gala sign-in',
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'gala-cli' }).toString()
      });
    },

    /** Returns the token, or null while the writer has not finished authorizing. */
    async pollDeviceAuthorization(deviceCode) {
      const response = await fetch(`${root}/v1/auth/device/token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: 'gala-cli'
        }).toString()
      });
      const body = await response.json().catch(() => null);
      if (response.ok) return body;
      if (body?.error === 'authorization_pending' || body?.error === 'slow_down') return null;
      throw new Error(`Gala sign-in failed: ${body?.error_description ?? body?.error ?? response.status}`);
    },

    request: (path, options) => request(`${root}${path}`, authorized(options?.action ?? path, options))
  };
}
