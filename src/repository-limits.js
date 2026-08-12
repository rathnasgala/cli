import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const MEBIBYTE = 1024 * 1024;

function gitRepositoryBytes(root, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, 'count-objects', '-v'], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) return reject(new Error(`Repository inspection terminated by signal ${signal}`));
      if (code !== 0) return reject(new Error(`Repository inspection failed: ${errors.trim()}`));
      const values = Object.fromEntries(output.trim().split('\n').map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), Number(line.slice(separator + 1).trim())];
      }));
      if (!Number.isFinite(values.size) || !Number.isFinite(values['size-pack'])) {
        return reject(new Error('Git returned invalid repository size metadata'));
      }
      resolve((values.size + values['size-pack']) * 1024);
    });
  });
}

async function countPosts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const counts = await Promise.all(entries.map((entry) => {
    if (entry.isDirectory()) return countPosts(path.join(directory, entry.name));
    return Promise.resolve(entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name) ? 1 : 0);
  }));
  return counts.reduce((total, count) => total + count, 0);
}

export function repositoryLimitWarnings({ repositoryBytes, postCount, buildDurationMs }) {
  const warnings = [];
  if (repositoryBytes > 800 * MEBIBYTE) {
    warnings.push({ severity: 'critical', code: 'repository-size-800mb' });
  } else if (repositoryBytes > 500 * MEBIBYTE) {
    warnings.push({ severity: 'warning', code: 'repository-size-500mb' });
  }
  if (postCount > 1000) warnings.push({ severity: 'warning', code: 'post-count-1000' });
  if (buildDurationMs != null && buildDurationMs > 5 * 60 * 1000) {
    warnings.push({ severity: 'warning', code: 'build-duration-5m' });
  }
  return warnings;
}

export async function inspectRepositoryLimits(root, { spawnProcess = spawn, buildDurationMs } = {}) {
  const resolvedRoot = path.resolve(root);
  const [repositoryBytes, postCount] = await Promise.all([
    gitRepositoryBytes(resolvedRoot, spawnProcess),
    countPosts(path.join(resolvedRoot, 'content', 'posts'))
  ]);
  return {
    repositoryBytes,
    postCount,
    warnings: repositoryLimitWarnings({ repositoryBytes, postCount, buildDurationMs })
  };
}

export async function reportRepositoryLimitWarnings(
  root,
  { spawnProcess = spawn, output = process.stderr } = {}
) {
  const resolvedRoot = path.resolve(root);
  try {
    const [gitMetadata, config, posts] = await Promise.all([
      lstat(path.join(resolvedRoot, '.git')),
      lstat(path.join(resolvedRoot, 'site.config.yml')),
      lstat(path.join(resolvedRoot, 'content', 'posts'))
    ]);
    if ((!gitMetadata.isDirectory() && !gitMetadata.isFile())
      || !config.isFile() || config.isSymbolicLink()
      || !posts.isDirectory() || posts.isSymbolicLink()) {
      return [];
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const { warnings } = await inspectRepositoryLimits(resolvedRoot, { spawnProcess });
  for (const { severity, code } of warnings) output.write(`${severity}\t${code}\n`);
  return warnings;
}
