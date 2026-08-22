import { galaApi, DEFAULT_API_BASE_URL } from '../api/gala.js';
import { credentialPath, forgetCredential, readCredential, writeCredential } from './store.js';

/**
 * The Gala sign-in.
 *
 * A stored credential is checked against the server before anything depends on it, because one
 * that parses and has not expired can still be one the API refuses — and discovering that four
 * calls later, as an opaque 401 from whichever endpoint got there first, is how a "sign in again"
 * became a stack trace.
 */
export async function galaCredential({
  terminal,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  target = credentialPath('credentials'),
  now = Date.now
}) {
  const stored = await readCredential(target);
  if (stored != null) {
    const accepted = await galaApi({ baseUrl: stored.apiBaseUrl ?? apiBaseUrl, token: stored.accessToken }).accepted();
    if (accepted) return stored;
    // Leaving it on disk makes every later command rediscover that it is refused.
    await forgetCredential(target);
    terminal.step('Your Gala sign-in is no longer valid');
  }

  const api = galaApi({ baseUrl: apiBaseUrl });
  const authorization = await api.startDeviceAuthorization();
  terminal.step('Sign in to Gala');
  terminal.openUrl(authorization.verification_uri);
  terminal.note(`code ${authorization.user_code}`);

  const token = await poll(api, authorization, now);
  await writeCredential(target, {
    accessToken: token.access_token,
    apiBaseUrl,
    expiresAt: new Date(now() + token.expires_in * 1000).toISOString()
  });
  terminal.done('Signed in to Gala');
  return readCredential(target);
}

async function poll(api, authorization, now) {
  const deadline = now() + authorization.expires_in * 1000;
  const interval = Math.max(1, authorization.interval ?? 5) * 1000;
  while (now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, interval); });
    const token = await api.pollDeviceAuthorization(authorization.device_code);
    if (token != null) return token;
  }
  throw new Error('Gala sign-in expired before it was authorized');
}
