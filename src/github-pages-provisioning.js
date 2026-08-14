const GITHUB_API_VERSION = '2026-03-10';
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

function required(value, field, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || (pattern != null && !pattern.test(value))) {
    throw new TypeError(`${field} is invalid`);
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

async function json(response, operation) {
  if (!response.ok) throw new Error(`GitHub ${operation} failed with HTTP ${response.status}`);
  return response.json();
}

export async function provisionGithubPages({
  owner, repository, accessToken, commitSha, fetchImpl = fetch,
  customDomain = null,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 5_000, maxPolls = 120
}) {
  const normalizedOwner = required(owner, 'owner', SEGMENT);
  const normalizedRepository = required(repository, 'repository', SEGMENT);
  const token = required(accessToken, 'accessToken');
  const sha = required(commitSha, 'commitSha', SHA);
  if (customDomain != null && (typeof customDomain !== 'string'
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(customDomain))) {
    throw new TypeError('customDomain is invalid');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError('pollIntervalMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxPolls) || maxPolls <= 0) {
    throw new TypeError('maxPolls must be a positive safe integer');
  }
  const requestHeaders = headers(token);
  const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepository)}`;
  const query = new URLSearchParams({ event: 'push', head_sha: sha, per_page: '10' });
  let run = null;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const response = await fetchImpl(`${repositoryUrl}/actions/workflows/publish.yml/runs?${query}`, {
      method: 'GET', headers: requestHeaders
    });
    const payload = await json(response, 'publish workflow runs request');
    run = payload.workflow_runs?.find((candidate) => candidate.head_sha === sha) ?? null;
    if (run?.status === 'completed') break;
    if (poll + 1 < maxPolls) await sleep(pollIntervalMs);
  }
  if (run == null || run.status !== 'completed') {
    throw new Error(`Timed out waiting for the publish workflow for ${sha}`);
  }
  if (run.conclusion !== 'success') {
    throw new Error(`Initial publish workflow failed: ${run.html_url}`);
  }
  const branch = await fetchImpl(`${repositoryUrl}/branches/gh-pages`, {
    method: 'GET', headers: requestHeaders
  });
  if (!branch.ok) {
    throw new Error(`Successful publish run created no gh-pages branch: ${run.html_url}`);
  }
  const current = await fetchImpl(`${repositoryUrl}/pages`, { method: 'GET', headers: requestHeaders });
  if (current.ok) {
    const configuration = await current.json();
    if (configuration.source?.branch !== 'gh-pages' || configuration.source?.path !== '/') {
      throw new Error('Existing GitHub Pages configuration does not use gh-pages at /');
    }
    if ((configuration.cname ?? null) !== customDomain) {
      const updated = await fetchImpl(`${repositoryUrl}/pages`, {
        method: 'PUT', headers: requestHeaders,
        body: JSON.stringify({ cname: customDomain, source: { branch: 'gh-pages', path: '/' } })
      });
      if (updated.status !== 204) {
        throw new Error(`GitHub Pages custom-domain update failed with HTTP ${updated.status}`);
      }
    }
    return Object.freeze({ created: false, url: configuration.html_url, runUrl: run.html_url });
  }
  if (current.status !== 404) {
    throw new Error(`GitHub Pages configuration request failed with HTTP ${current.status}`);
  }
  const created = await fetchImpl(`${repositoryUrl}/pages`, {
    method: 'POST', headers: requestHeaders,
    body: JSON.stringify({ source: { branch: 'gh-pages', path: '/' } })
  });
  const configuration = await json(created, 'Pages activation');
  if (customDomain != null) {
    const updated = await fetchImpl(`${repositoryUrl}/pages`, {
      method: 'PUT', headers: requestHeaders,
      body: JSON.stringify({ cname: customDomain, source: { branch: 'gh-pages', path: '/' } })
    });
    if (updated.status !== 204) {
      throw new Error(`GitHub Pages custom-domain update failed with HTTP ${updated.status}`);
    }
  }
  return Object.freeze({ created: true, url: configuration.html_url, runUrl: run.html_url });
}
