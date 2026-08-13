import { pollForAccessToken, requestDeviceCode } from './github-device-flow.js';
import { writeGithubCredential } from './github-credential-store.js';

export const GITHUB_OAUTH_CLIENT_ID = 'Ov23ligTfectgl2FHJ6c';
export const GITHUB_SCAFFOLD_SCOPES = Object.freeze(['repo', 'workflow']);

export async function authenticateGithub({
  clientId = GITHUB_OAUTH_CLIENT_ID, fetchImpl = fetch, sleep, now = Date.now,
  showScopeWarning, showInstructions, credentialTarget
} = {}) {
  if (typeof showScopeWarning !== 'function' || typeof showInstructions !== 'function') {
    throw new TypeError('scope warning and device instructions are required');
  }
  showScopeWarning({
    scopes: GITHUB_SCAFFOLD_SCOPES,
    explanation: 'repo grants read/write access to every public and private repository you can access; workflow is used only for scaffold and explicit action-major migration.'
  });
  const authorization = await requestDeviceCode({ clientId, scopes: GITHUB_SCAFFOLD_SCOPES, fetchImpl });
  showInstructions(authorization);
  const token = await pollForAccessToken({
    ...authorization, clientId, requiredScopes: GITHUB_SCAFFOLD_SCOPES, fetchImpl,
    ...(sleep == null ? {} : { sleep }), now
  });
  const target = await writeGithubCredential({
    accessToken: token.accessToken, scopes: token.scopes,
    ...(credentialTarget == null ? {} : { target: credentialTarget })
  });
  return Object.freeze({ target, scopes: token.scopes });
}
