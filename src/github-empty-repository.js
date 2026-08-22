import { spawn } from 'node:child_process';
import { describeHttpFailure } from './http-failure.js';

const API_VERSION = '2026-03-10';

export async function verifyEmptyRepository({ owner, repository, accessToken, fetchImpl = fetch }) {
  const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const headers = {
    accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`,
    'x-github-api-version': API_VERSION
  };
  const response = await fetchImpl(repositoryUrl, {
    headers
  });
  if (!response.ok) throw new Error(await describeHttpFailure(response, 'GitHub repository lookup'));
  const payload = await response.json();
  if (payload.full_name?.toLowerCase() !== `${owner}/${repository}`.toLowerCase()) {
    throw new TypeError('GitHub returned an unexpected repository');
  }
  const branchesResponse = await fetchImpl(`${repositoryUrl}/branches?per_page=1`, {
    headers: {
      ...headers
    }
  });
  if (!branchesResponse.ok) throw new Error(await describeHttpFailure(branchesResponse, 'GitHub branch lookup'));
  const branches = await branchesResponse.json();
  if (payload.size !== 0 || !Array.isArray(branches) || branches.length !== 0) {
    throw new Error('Existing repository is not empty; explicit non-empty adoption is not implemented');
  }
}

export function setRepositoryOrigin({ root, owner, repository, spawnProcess = spawn }) {
  const target = `https://github.com/${owner}/${repository}.git`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, 'remote', 'set-url', 'origin', target], {
      cwd: root, shell: false, stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git remote update terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git remote update exited with code ${code}`));
      else resolve();
    });
  });
}

export function verifyRepositoryOrigin({ root, owner, repository, spawnProcess = spawn }) {
  const expected = `https://github.com/${owner}/${repository}.git`;
  const expectedPath = `/${owner}/${repository}.git`;
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      cwd: root, shell: false, stdio: ['ignore', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git origin verification terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git origin verification exited with code ${code}`));
      else {
        let origin;
        try {
          origin = new URL(output.trim());
        } catch {
          reject(new Error(`Existing checkout origin must be ${expected}`));
          return;
        }
        if (origin.protocol !== 'https:' || origin.hostname !== 'github.com' || origin.port !== ''
            || origin.pathname !== expectedPath || origin.search !== '' || origin.hash !== '') {
          reject(new Error(`Existing checkout origin must be ${expected}`));
        } else resolve(root);
      }
    });
  });
}
