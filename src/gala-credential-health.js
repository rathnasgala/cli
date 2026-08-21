/**
 * Whether a stored Gala credential is one the server will still accept.
 *
 * `readGalaCredential` can only check what is written in the file — schema and expiry — and a
 * credential can satisfy both while the API refuses it outright. It happened: the API stopped
 * putting a `tenant` claim in its tokens and now rejects any token that still carries one
 * (Rs256JwtCodec: "Legacy tenant-bearing token requires reauthentication"). Tokens minted before
 * that change have a month-long expiry, so every command using one sent a bearer the server had
 * already decided to refuse, and reported it as whatever call happened to fail first.
 *
 * Expiry is not the only way a credential dies. It can be revoked, the signing key can rotate, the
 * claim set can change again. So this does not special-case the `tenant` claim: it asks the server,
 * once, and treats 401 as "this credential is finished" — which is true whatever the reason.
 */
const PROBE_PATH = '/v1/me/sites';

/**
 * Answers whether the API still accepts this credential.
 *
 * A network failure is deliberately not an answer: refusing to run because the machine is briefly
 * offline, or forcing a sign-in the writer does not need, are both worse than letting the real
 * call fail with its own error.
 */
export async function galaCredentialAccepted({ apiBaseUrl, accessToken, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${String(apiBaseUrl).replace(/\/$/, '')}${PROBE_PATH}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
    });
  } catch {
    return true;
  }
  return response.status !== 401;
}
