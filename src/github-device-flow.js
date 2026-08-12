const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

async function postForm(fetchImpl, url, fields) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields)
  });
  if (!response.ok) {
    throw new Error(`GitHub OAuth request failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload == null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TypeError('GitHub OAuth response must be a JSON object');
  }
  return payload;
}

export async function requestDeviceCode({ clientId, scopes, fetchImpl = fetch }) {
  const normalizedClientId = requiredString(clientId, 'clientId');
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TypeError('scopes must be a non-empty list');
  }
  const normalizedScopes = scopes.map((scope) => requiredString(scope, 'scope'));
  const payload = await postForm(fetchImpl, DEVICE_CODE_URL, {
    client_id: normalizedClientId,
    scope: normalizedScopes.join(' ')
  });

  return Object.freeze({
    deviceCode: requiredString(payload.device_code, 'device_code'),
    userCode: requiredString(payload.user_code, 'user_code'),
    verificationUri: requiredString(payload.verification_uri, 'verification_uri'),
    expiresInSeconds: positiveInteger(payload.expires_in, 'expires_in'),
    intervalSeconds: positiveInteger(payload.interval, 'interval')
  });
}

export async function pollForAccessToken({
  clientId,
  deviceCode,
  expiresInSeconds,
  intervalSeconds,
  requiredScopes = [],
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now
}) {
  const normalizedClientId = requiredString(clientId, 'clientId');
  const normalizedDeviceCode = requiredString(deviceCode, 'deviceCode');
  if (!Array.isArray(requiredScopes)) throw new TypeError('requiredScopes must be a list');
  const normalizedRequiredScopes = requiredScopes.map((scope) =>
    requiredString(scope, 'scope').toLowerCase()
  );
  const lifetime = positiveInteger(expiresInSeconds, 'expiresInSeconds') * 1000;
  let interval = positiveInteger(intervalSeconds, 'intervalSeconds');
  const startedAt = now();
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    throw new TypeError('Clock must return epoch milliseconds');
  }

  while (true) {
    await sleep(interval * 1000);
    const currentTime = now();
    if (typeof currentTime !== 'number' || !Number.isFinite(currentTime)) {
      throw new TypeError('Clock must return epoch milliseconds');
    }
    if (currentTime - startedAt >= lifetime) {
      throw new Error('GitHub device code expired before authorization completed');
    }

    const payload = await postForm(fetchImpl, ACCESS_TOKEN_URL, {
      client_id: normalizedClientId,
      device_code: normalizedDeviceCode,
      grant_type: DEVICE_GRANT
    });
    if (typeof payload.access_token === 'string' && payload.access_token !== '') {
      const tokenType = requiredString(payload.token_type, 'token_type');
      if (tokenType.toLowerCase() !== 'bearer') {
        throw new TypeError('GitHub OAuth token_type must be bearer');
      }
      const grantedScopes = typeof payload.scope === 'string'
        ? payload.scope.split(/[,\s]+/).map((scope) => scope.trim().toLowerCase()).filter(Boolean)
        : [];
      const missingScopes = normalizedRequiredScopes.filter((scope) => !grantedScopes.includes(scope));
      if (missingScopes.length > 0) {
        throw new Error(`GitHub authorization omitted required scope(s): ${missingScopes.join(', ')}`);
      }
      return Object.freeze({
        accessToken: requiredString(payload.access_token, 'access_token'),
        tokenType: 'bearer',
        scopes: grantedScopes
      });
    }

    if (payload.error === 'authorization_pending') continue;
    if (payload.error === 'slow_down') {
      interval = Number.isSafeInteger(payload.interval) && payload.interval > interval
        ? payload.interval
        : interval + 5;
      continue;
    }
    if (payload.error === 'expired_token' || payload.error === 'token_expired') {
      throw new Error('GitHub device code expired before authorization completed');
    }
    if (typeof payload.error === 'string' && payload.error !== '') {
      throw new Error(`GitHub device authorization failed: ${payload.error}`);
    }
    throw new TypeError('GitHub OAuth response contained neither a token nor an error');
  }
}
