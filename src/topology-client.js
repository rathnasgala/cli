const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function endpoint(apiBaseUrl, siteId, suffix) {
  if (!ULID.test(siteId)) throw new TypeError('siteId is invalid');
  const base = new URL(apiBaseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(loopback && base.protocol === 'http:'))
      || base.username || base.password || base.search || base.hash) {
    throw new TypeError('apiBaseUrl must be a credential-free HTTPS URL (or HTTP loopback for testing)');
  }
  return new URL(`/v1/sites/${siteId}/topology-changes/${suffix}`, base).href;
}

async function response(response, operation) {
  if (response.status === 401) throw new Error('Gala authentication expired; run `gala auth` again');
  if (response.status === 404) throw new Error('Site is unavailable');
  if (response.status === 409) throw new Error(`Topology ${operation} conflicts with protected state`);
  if (!response.ok) throw new Error(`Topology ${operation} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!ULID.test(payload?.changeId)) throw new TypeError('Topology response is invalid');
  return Object.freeze(payload);
}

export async function prepareTopologyChange({
  apiBaseUrl, accessToken, siteId, canonicalBaseUrl, pathPrefix, fetchImpl = fetch
}) {
  const result = await fetchImpl(endpoint(apiBaseUrl, siteId, 'prepare'), {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ canonicalBaseUrl, pathPrefix })
  });
  return response(result, 'prepare');
}

export async function commitTopologyChange({
  apiBaseUrl, accessToken, siteId, changeId, fetchImpl = fetch
}) {
  if (!ULID.test(changeId)) throw new TypeError('changeId is invalid');
  const result = await fetchImpl(endpoint(apiBaseUrl, siteId, `${changeId}/commit`), {
    method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
  });
  return response(result, 'commit');
}
