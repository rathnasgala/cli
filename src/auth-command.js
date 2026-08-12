import { pollForGalaToken, requestGalaDeviceCode } from './gala-device-flow.js';
import { writeGalaCredential } from './gala-credential-store.js';

export async function authenticateGala({
  apiBaseUrl = 'https://api.gala67.com',
  clientId = 'gala-cli',
  fetchImpl = fetch,
  sleep,
  now = Date.now,
  showInstructions,
  credentialTarget
} = {}) {
  if (typeof showInstructions !== 'function') throw new TypeError('showInstructions is required');
  const authorization = await requestGalaDeviceCode({ apiBaseUrl, clientId, fetchImpl });
  showInstructions({
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
    userCode: authorization.userCode
  });
  const token = await pollForGalaToken({
    ...authorization,
    apiBaseUrl,
    clientId,
    fetchImpl,
    ...(sleep == null ? {} : { sleep }),
    now
  });
  const expiresAt = new Date(now() + token.expiresInSeconds * 1000);
  const target = await writeGalaCredential({
    accessToken: token.accessToken,
    expiresAt,
    apiBaseUrl,
    ...(credentialTarget == null ? {} : { target: credentialTarget })
  });
  return Object.freeze({ target, expiresAt });
}
