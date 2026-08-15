const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function required(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function apiUrl(apiBaseUrl) {
  const base = new URL(apiBaseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) {
    throw new TypeError('apiBaseUrl must be a credential-free HTTPS URL (or HTTP loopback for testing)');
  }
  return new URL('/v1/sites', base).href;
}

async function authorizeGitHub({ apiBaseUrl, galaAccessToken, githubAccessToken, fetchImpl }) {
  if (typeof githubAccessToken !== 'string' || githubAccessToken === '') {
    throw new Error('GitHub authentication is missing; run `gala auth`');
  }
  const response = await fetchImpl(new URL('/v1/auth/github/device-authorizations', apiBaseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${galaAccessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ accessToken: githubAccessToken })
  });
  if (response.status === 401) {
    throw new Error('GitHub or Gala authentication expired; run `gala auth` again');
  }
  if (response.status !== 200) {
    throw new Error(`GitHub repository authorization failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  return required(payload?.authorization, 'GitHub authorization', /^[A-Za-z0-9_-]{43}$/);
}

export async function registerSite({
  apiBaseUrl = 'https://api.gala67.com',
  galaAccessToken,
  githubAccessToken,
  idempotencyKey,
  githubInstallationId,
  repositoryOwner,
  repositoryName,
  topology,
  canonicalBaseUrl,
  fetchImpl = fetch
}) {
  if (typeof galaAccessToken !== 'string' || galaAccessToken === '') {
    throw new Error('Gala authentication is missing; run `gala auth`');
  }
  const githubAuthorization = await authorizeGitHub({
    apiBaseUrl, galaAccessToken, githubAccessToken, fetchImpl
  });
  required(idempotencyKey, 'idempotencyKey', IDEMPOTENCY_KEY);
  required(repositoryOwner, 'repositoryOwner', REPOSITORY_PART);
  required(repositoryName, 'repositoryName', REPOSITORY_PART);
  if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId <= 0) {
    throw new TypeError('githubInstallationId must be a positive integer');
  }
  if (!['PROVIDER_DEFAULT', 'CUSTOM_DOMAIN'].includes(topology)) {
    throw new TypeError('topology is invalid');
  }
  const response = await fetchImpl(apiUrl(apiBaseUrl), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${galaAccessToken}`,
      'content-type': 'application/json',
      'github-authorization': githubAuthorization,
      'idempotency-key': idempotencyKey
    },
    body: JSON.stringify({
      githubInstallationId,
      repositoryOwner,
      repositoryName,
      topology,
      canonicalBaseUrl
    })
  });
  if (response.status === 401) {
    throw new Error('Gala authentication expired; run `gala auth` again');
  }
  if (response.status === 404) {
    throw new Error(`GitHub App installation does not cover ${repositoryOwner}/${repositoryName}`);
  }
  if (response.status === 409) {
    throw new Error('Site registration conflicts with existing protected state; use the recovery command');
  }
  if (response.status !== 201) throw new Error(`Gala site registration failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!ULID.test(payload?.siteId) || typeof payload.siteSecret !== 'string' || payload.siteSecret === '') {
    throw new TypeError('Gala site registration response is invalid');
  }
  const canonical = new URL(payload.canonicalBaseUrl);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password
      || canonical.search || canonical.hash || canonical.pathname !== '/') {
    throw new TypeError('Gala site registration returned an invalid canonicalBaseUrl');
  }
  if (typeof payload.pathPrefix !== 'string'
      || !/^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/.test(payload.pathPrefix)) {
    throw new TypeError('Gala site registration returned an invalid pathPrefix');
  }
  const location = response.headers?.get?.('location');
  if (location !== `/v1/sites/${payload.siteId}`) {
    throw new TypeError('Gala site registration returned an invalid Location header');
  }
  return Object.freeze({
    siteId: payload.siteId,
    siteSecret: payload.siteSecret,
    canonicalBaseUrl: canonical.origin,
    pathPrefix: payload.pathPrefix === '' ? '/' : payload.pathPrefix
  });
}
