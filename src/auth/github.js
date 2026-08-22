import { credentialPath, readCredential, writeCredential } from './store.js';

/**
 * The GitHub sign-in, as the Gala App.
 *
 * v0 authenticated as a separate OAuth App while the browser editor used the GitHub App. They are
 * two different identity systems and every difference fell on the CLI: an OAuth token cannot list
 * App installations, organisations with OAuth App restrictions refuse it outright, and it inherits
 * none of the App's repository grants. The editor hit none of that, which is why the two behaved
 * so differently for so long.
 *
 * Client IDs are public; this is the value `GET /apps/gala67-app` publishes.
 */
export const APP_CLIENT_ID = 'Iv23liIg7Hi1lMesiaon';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export async function githubCredential({
  terminal,
  clientId = APP_CLIENT_ID,
  target = credentialPath('github-credentials'),
  now = Date.now
}) {
  const stored = await readCredential(target);
  if (stored != null) return stored;

  // No scopes. A GitHub App's permissions are fixed on the app and granted when the writer installs
  // it, so there is nothing to negotiate — and nothing to warn them about, which is why the broad
  // "read/write on every repository you can access" notice is gone.
  const authorization = await post(DEVICE_CODE_URL, { client_id: clientId }, 'GitHub sign-in');
  terminal.step('Sign in to GitHub');
  terminal.openUrl(authorization.verification_uri);
  terminal.note(`code ${authorization.user_code}`);

  const token = await poll(clientId, authorization, now);
  await writeCredential(target, {
    accessToken: token.access_token,
    // The app expires user tokens after eight hours and issues a refresh token with each. Exchanging
    // one needs the app's client secret, which a published CLI cannot hold — so it is kept for the
    // API-side refresh, and until that exists an expired credential asks for one sign-in rather
    // than failing as an unexplained 401 somewhere deeper.
    ...(token.expires_in ? { expiresAt: new Date(now() + token.expires_in * 1000).toISOString() } : {}),
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {})
  });
  terminal.done('Signed in to GitHub');
  return readCredential(target);
}

async function poll(clientId, authorization, now) {
  const deadline = now() + authorization.expires_in * 1000;
  let interval = Math.max(1, authorization.interval ?? 5) * 1000;
  while (now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, interval); });
    const payload = await post(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: authorization.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    }, 'GitHub sign-in');
    if (typeof payload.access_token === 'string' && payload.access_token !== '') return payload;
    if (payload.error === 'slow_down') interval += 5000;
    else if (payload.error !== 'authorization_pending') {
      throw new Error(`GitHub sign-in failed: ${payload.error_description ?? payload.error}`);
    }
  }
  throw new Error('GitHub sign-in expired before it was authorized');
}

async function post(url, form, action) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  });
  const payload = await response.json().catch(() => null);
  if (payload == null) throw new Error(`${action} returned an unreadable response`);
  return payload;
}
