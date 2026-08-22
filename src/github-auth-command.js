import { pollForAccessToken, requestDeviceCode } from './github-device-flow.js';
import { writeGithubCredential } from './github-credential-store.js';

/**
 * The Gala GitHub App, not an OAuth App.
 *
 * The CLI used to authenticate as a separate OAuth App (`Ov23ligTfectgl2FHJ6c`) while the browser
 * editor used the GitHub App. They are two different identity systems, and every difference fell on
 * the CLI: an OAuth token cannot list App installations, is blocked by organisation OAuth App
 * restrictions, and inherits none of the App's repository grants. The editor hit none of that.
 *
 * The one thing that forced an OAuth App — the CLI creating repositories before any installation
 * covered them — no longer applies: creation moved to the API. So both clients are now the same
 * GitHub App, and the differences disappear rather than being worked around.
 *
 * Client IDs are public; this is the value `GET /apps/gala67-app` publishes.
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23liIg7Hi1lMesiaon';

export async function authenticateGithub({
  clientId = GITHUB_APP_CLIENT_ID, fetchImpl = fetch, sleep, now = Date.now,
  showInstructions, credentialTarget
} = {}) {
  if (typeof showInstructions !== 'function') {
    throw new TypeError('device instructions are required');
  }
  // No scopes: a GitHub App's permissions are fixed on the app and granted at installation, so
  // there is nothing to negotiate and nothing to warn about. The broad `repo` scope the OAuth App
  // had to request — read/write on every repository the writer could reach — is gone with it.
  const authorization = await requestDeviceCode({ clientId, fetchImpl });
  showInstructions(authorization);
  const token = await pollForAccessToken({
    ...authorization, clientId, fetchImpl,
    ...(sleep == null ? {} : { sleep }), now
  });
  /*
   * The app expires user tokens after eight hours and issues a refresh token with each one.
   * Exchanging that refresh token requires the app's client secret, which a published CLI cannot
   * hold — so it is stored for the API-side refresh that will do the exchange, and until that
   * exists an expired credential asks for one sign-in rather than failing somewhere further down
   * as an unexplained 401.
   */
  const target = await writeGithubCredential({
    accessToken: token.accessToken,
    ...(token.expiresAt == null ? {} : { expiresAt: token.expiresAt }),
    ...(token.refreshToken == null ? {} : { refreshToken: token.refreshToken }),
    ...(credentialTarget == null ? {} : { target: credentialTarget })
  });
  return Object.freeze({ target, expiresAt: token.expiresAt ?? null });
}
