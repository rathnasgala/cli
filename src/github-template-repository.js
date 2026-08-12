import { spawn } from 'node:child_process';
import path from 'node:path';

const GITHUB_API_VERSION = '2026-03-10';
const REPOSITORY_IDENTITY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function repositorySegment(value, field) {
  const segment = requiredString(value, field);
  if (!/^[A-Za-z0-9_.-]+$/.test(segment)) {
    throw new TypeError(`${field} contains unsupported characters`);
  }
  return segment;
}

export async function generateRepositoryFromTemplate({
  accessToken,
  templateOwner,
  templateRepository,
  owner,
  repository,
  description,
  fetchImpl = fetch
}) {
  const token = requiredString(accessToken, 'accessToken');
  const sourceOwner = repositorySegment(templateOwner, 'templateOwner');
  const sourceRepository = repositorySegment(templateRepository, 'templateRepository');
  const targetOwner = repositorySegment(owner, 'owner');
  const targetRepository = repositorySegment(repository, 'repository');
  if (description != null && typeof description !== 'string') {
    throw new TypeError('description must be a string');
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceRepository)}/generate`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': GITHUB_API_VERSION
      },
      body: JSON.stringify({
        owner: targetOwner,
        name: targetRepository,
        description: description ?? '',
        include_all_branches: false,
        private: false
      })
    }
  );
  if (response.status !== 201) {
    throw new Error(`GitHub template generation failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload == null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TypeError('GitHub repository response must be a JSON object');
  }
  const fullName = requiredString(payload.full_name, 'full_name');
  if (!REPOSITORY_IDENTITY.test(fullName)) {
    throw new TypeError('GitHub repository response contains an invalid full_name');
  }
  if (fullName.toLowerCase() !== `${targetOwner}/${targetRepository}`.toLowerCase()) {
    throw new TypeError('GitHub generated an unexpected repository');
  }

  const cloneUrl = new URL(requiredString(payload.clone_url, 'clone_url'));
  if (
    cloneUrl.protocol !== 'https:'
    || cloneUrl.hostname !== 'github.com'
    || cloneUrl.username !== ''
    || cloneUrl.password !== ''
    || cloneUrl.search !== ''
    || cloneUrl.hash !== ''
    || cloneUrl.pathname.toLowerCase() !== `/${fullName}.git`.toLowerCase()
  ) {
    throw new TypeError('GitHub repository response contains an invalid clone_url');
  }

  return Object.freeze({ fullName, cloneUrl: cloneUrl.href });
}

export function cloneRepository({ cloneUrl, target, spawnProcess = spawn }) {
  const source = new URL(requiredString(cloneUrl, 'cloneUrl'));
  if (
    source.protocol !== 'https:'
    || source.hostname !== 'github.com'
    || source.username !== ''
    || source.password !== ''
    || source.search !== ''
    || source.hash !== ''
  ) {
    throw new TypeError('cloneUrl must be an uncredentialed GitHub HTTPS URL');
  }
  const resolvedTarget = path.resolve(requiredString(target, 'target'));

  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['clone', source.href, resolvedTarget], {
      cwd: path.dirname(resolvedTarget),
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git clone terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git clone exited with code ${code}`));
      else resolve(resolvedTarget);
    });
  });
}
