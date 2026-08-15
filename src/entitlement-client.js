const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const FIELDS = ['expiresAt', 'issuedAt', 'keyId', 'signature', 'siteId', 'tier'];

export async function fetchAttributionEntitlement({ siteId, credential, fetchImpl = fetch }) {
  if (!ULID.test(siteId)) throw new TypeError('siteId must be a canonical ULID');
  const endpoint = new URL(`/v1/sites/${siteId}/attribution-entitlement`, credential.apiBaseUrl);
  const loopback = endpoint.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopback) || endpoint.username || endpoint.password) {
    throw new TypeError('Gala API URL must be credential-free HTTPS or HTTP loopback');
  }
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Attribution entitlement retrieval failed with HTTP ${response.status}`);
  const artifact = await response.json();
  if (artifact == null || Array.isArray(artifact) || typeof artifact !== 'object'
      || Object.keys(artifact).sort().join('\0') !== FIELDS.join('\0')
      || artifact.siteId !== siteId || artifact.tier !== 'PAID'
      || !['issuedAt', 'expiresAt', 'keyId', 'signature'].every(
        (field) => typeof artifact[field] === 'string' && artifact[field].length > 0
      )) {
    throw new TypeError('Attribution entitlement response is invalid');
  }
  return artifact;
}
