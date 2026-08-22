import { describeHttpFailure } from './http-failure.js';
const GITHUB_API_VERSION = '2026-03-10';
const OWNER_OR_REPOSITORY = /^[A-Za-z0-9_.-]+$/;
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

function required(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function requiredValue(value, field) {
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

export async function installRepositoryVariable({
  owner, repository, accessToken, variableName, variableValue, fetchImpl = fetch
}) {
  const normalizedOwner = required(owner, 'owner', OWNER_OR_REPOSITORY);
  const normalizedRepository = required(repository, 'repository', OWNER_OR_REPOSITORY);
  const normalizedName = required(variableName, 'variableName', VARIABLE_NAME);
  const token = requiredValue(accessToken, 'accessToken');
  const value = requiredValue(variableValue, 'variableValue');
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepository)}/actions/variables`;
  const requestHeaders = headers(token);
  const update = await fetchImpl(`${baseUrl}/${encodeURIComponent(normalizedName)}`, {
    method: 'PATCH',
    headers: requestHeaders,
    body: JSON.stringify({ name: normalizedName, value })
  });
  if (update.ok) return;
  if (update.status !== 404) {
    throw new Error(await describeHttpFailure(update, 'GitHub repository variable update'));
  }
  const create = await fetchImpl(baseUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ name: normalizedName, value })
  });
  if (!create.ok) {
    throw new Error(await describeHttpFailure(create, 'GitHub repository variable creation'));
  }
}
