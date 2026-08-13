const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be positive`);
  return value;
}

function apiUrl(apiBaseUrl, path) {
  const base = new URL(requiredString(apiBaseUrl, 'apiBaseUrl'));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) {
    throw new TypeError('apiBaseUrl must be a credential-free HTTPS URL (or HTTP loopback for testing)');
  }
  return new URL(path, base).href;
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
  let payload;
  try {
    payload = await response.json();
  } catch {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    throw new TypeError(`Gala device authorization returned invalid JSON${status}`);
  }
  if (payload == null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TypeError('Gala device authorization response must be a JSON object');
  }
  return { response, payload };
}

export async function requestGalaDeviceCode({
  apiBaseUrl = 'https://api.gala67.com',
  clientId = 'gala-cli',
  fetchImpl = fetch
} = {}) {
  const { response, payload } = await postForm(
    fetchImpl,
    apiUrl(apiBaseUrl, '/v1/auth/device/code'),
    { client_id: requiredString(clientId, 'clientId') }
  );
  if (!response.ok) throw new Error(`Gala device authorization failed with HTTP ${response.status}`);
  return Object.freeze({
    deviceCode: requiredString(payload.device_code, 'device_code'),
    userCode: requiredString(payload.user_code, 'user_code'),
    verificationUri: requiredString(payload.verification_uri, 'verification_uri'),
    verificationUriComplete: requiredString(
      payload.verification_uri_complete,
      'verification_uri_complete'
    ),
    expiresInSeconds: positiveInteger(payload.expires_in, 'expires_in'),
    intervalSeconds: positiveInteger(payload.interval ?? 5, 'interval')
  });
}

export async function pollForGalaToken({
  deviceCode,
  expiresInSeconds,
  intervalSeconds,
  apiBaseUrl = 'https://api.gala67.com',
  clientId = 'gala-cli',
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now
}) {
  const code = requiredString(deviceCode, 'deviceCode');
  const lifetime = positiveInteger(expiresInSeconds, 'expiresInSeconds') * 1000;
  let interval = positiveInteger(intervalSeconds, 'intervalSeconds');
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError('Clock must return epoch milliseconds');

  while (true) {
    await sleep(interval * 1000);
    const currentTime = now();
    if (!Number.isFinite(currentTime)) throw new TypeError('Clock must return epoch milliseconds');
    if (currentTime - startedAt >= lifetime) {
      throw new Error('Gala device authorization expired; run `gala auth` again');
    }
    const { response, payload } = await postForm(
      fetchImpl,
      apiUrl(apiBaseUrl, '/v1/auth/device/token'),
      {
        grant_type: DEVICE_GRANT,
        device_code: code,
        client_id: requiredString(clientId, 'clientId')
      }
    );
    if (response.ok) {
      if (requiredString(payload.token_type, 'token_type').toLowerCase() !== 'bearer') {
        throw new TypeError('Gala token_type must be bearer');
      }
      return Object.freeze({
        accessToken: requiredString(payload.access_token, 'access_token'),
        expiresInSeconds: positiveInteger(payload.expires_in, 'expires_in')
      });
    }
    if (payload.error === 'authorization_pending') continue;
    if (payload.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (payload.error === 'expired_token') {
      throw new Error('Gala device authorization expired; run `gala auth` again');
    }
    if (payload.error === 'access_denied') throw new Error('Gala device authorization was denied');
    throw new Error(`Gala device authorization failed: ${requiredString(payload.error, 'error')}`);
  }
}
