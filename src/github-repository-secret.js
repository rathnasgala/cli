import sodium from 'libsodium-wrappers';

const GITHUB_API_VERSION = '2026-03-10';
const OWNER_OR_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

function required(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requiredSecret(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return value;
}

function headers(accessToken) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'x-github-api-version': GITHUB_API_VERSION
  };
}

async function requireSuccess(response, operation) {
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new Error(`GitHub ${operation} failed with HTTP ${status}`);
  }
}

export async function installRepositorySecret({
  owner,
  repository,
  accessToken,
  secretName,
  secretValue,
  fetchImpl = fetch,
  sodiumImpl = sodium
}) {
  const normalizedOwner = required(owner, 'owner', OWNER_OR_REPOSITORY);
  const normalizedRepository = required(repository, 'repository', OWNER_OR_REPOSITORY);
  const normalizedSecretName = required(secretName, 'secretName', SECRET_NAME);
  const token = requiredSecret(accessToken, 'accessToken');
  const plaintext = requiredSecret(secretValue, 'secretValue');

  await sodiumImpl.ready;

  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepository)}/actions/secrets`;
  const publicKeyResponse = await fetchImpl(`${baseUrl}/public-key`, {
    method: 'GET',
    headers: headers(token)
  });
  await requireSuccess(publicKeyResponse, 'repository public-key request');
  const publicKeyPayload = await publicKeyResponse.json();
  const keyId = requiredSecret(publicKeyPayload?.key_id, 'GitHub key_id');
  const publicKey = requiredSecret(publicKeyPayload?.key, 'GitHub public key');

  const ciphertext = sodiumImpl.crypto_box_seal(
    sodiumImpl.from_string(plaintext),
    sodiumImpl.from_base64(publicKey, sodiumImpl.base64_variants.ORIGINAL)
  );
  const encryptedValue = sodiumImpl.to_base64(
    ciphertext,
    sodiumImpl.base64_variants.ORIGINAL
  );

  const uploadResponse = await fetchImpl(
    `${baseUrl}/${encodeURIComponent(normalizedSecretName)}`,
    {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId })
    }
  );
  await requireSuccess(uploadResponse, 'repository secret upload');
}
