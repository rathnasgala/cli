import { readFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseFrontmatter } from '@rathnasgala/content-validation';

import { repositoryEvaluationDate } from './evaluation-date.js';
import { recordSuccessfulDeployment } from './publication-state.js';
import { BUILD_MANIFEST_PATH } from './validate-command.js';

function runGit(root, args, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, ...args], {
      cwd: root,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git terminated by signal ${signal}`));
      else resolve(code);
    });
  });
}

function readHead(root, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      shell: false,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git rev-parse exited with code ${code}`));
      else {
        const sha = output.trim();
        if (!/^[0-9a-f]{40}$/.test(sha)) reject(new Error('Git returned an invalid HEAD SHA'));
        else resolve(sha);
      }
    });
  });
}

async function assignedContentPaths(root, manifest) {
  const assigned = manifest.assignedContentIds ?? [];
  if (!Array.isArray(assigned)) throw new TypeError('assignedContentIds must be a list');
  const sources = new Set();
  for (const item of assigned) {
    if (item == null
        || typeof item.source !== 'string'
        || !/^content\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.md$/.test(item.source)
        || typeof item.id !== 'string'
        || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(item.id)
        || typeof item.fileHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(item.fileHash)
        || sources.has(item.source)) {
      throw new TypeError('assignedContentIds contains an invalid entry');
    }
    const file = path.resolve(root, item.source);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`Assigned-ID source must be a regular file: ${item.source}`);
    }
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== item.fileHash) {
      throw new Error(`Assigned-ID source changed after the deployed build: ${item.source}`);
    }
    const parsed = parseFrontmatter(bytes.toString('utf8'));
    if (parsed.errors.length > 0 || parsed.data.id !== item.id) {
      throw new Error(`Assigned-ID source no longer contains its deployed ULID: ${item.source}`);
    }
    sources.add(item.source);
  }
  return [...sources].sort();
}

export async function recordDeployment({
  root,
  deployedOn,
  now,
  deployedCommitSha,
  spawnProcess = spawn
}) {
  const siteRoot = path.resolve(root);
  const manifestPath = path.join(siteRoot, BUILD_MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Current validated build manifest is missing; deployment cannot be recorded');
    }
    throw new TypeError(`Current validated build manifest is invalid: ${error.message}`);
  }
  const date = deployedOn ?? await repositoryEvaluationDate({ root: siteRoot, now });
  if (typeof deployedCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(deployedCommitSha)) {
    throw new TypeError('record-deployment requires --commit-sha <lowercase 40-character SHA>');
  }
  const head = await readHead(siteRoot, spawnProcess);
  if (deployedCommitSha !== head) {
    throw new Error(`Deployment SHA ${deployedCommitSha} does not match checkout HEAD ${head}`);
  }
  const state = await recordSuccessfulDeployment({
    root: siteRoot,
    manifest,
    deployedOn: date,
    deployedCommitSha
  });
  const statePath = '.gala/publication-state.yml';
  const contentPaths = await assignedContentPaths(siteRoot, manifest);
  const committedPaths = [statePath, ...contentPaths];
  const addCode = await runGit(siteRoot, ['add', '--', ...committedPaths], spawnProcess);
  if (addCode !== 0) throw new Error(`Git add exited with code ${addCode}`);
  const diffCode = await runGit(
    siteRoot,
    ['diff', '--cached', '--quiet', '--exit-code', '--', ...committedPaths],
    spawnProcess
  );
  if (diffCode === 0) return { state, pushed: false, recordedStateSha: head };
  if (diffCode !== 1) throw new Error(`Git diff exited with code ${diffCode}`);
  const assignmentTrailers = (manifest.assignedContentIds ?? []).map(
    ({ id, source }) => `Gala-Assigned-ID: ${id} ${source}`
  );
  const commitMessage = [
    'chore(gala): record successful deployment [skip ci]',
    '',
    `Gala-Deployed-SHA: ${deployedCommitSha}`,
    ...assignmentTrailers
  ].join('\n');
  const commitCode = await runGit(siteRoot, [
    'commit', '--only', '-m', commitMessage,
    '--', ...committedPaths
  ], spawnProcess);
  if (commitCode !== 0) throw new Error(`Git commit exited with code ${commitCode}`);
  const recordedStateSha = await readHead(siteRoot, spawnProcess);
  if (recordedStateSha === deployedCommitSha) {
    throw new Error('Git did not create a distinct recorded-state commit');
  }
  const pushCode = await runGit(siteRoot, ['push'], spawnProcess);
  if (pushCode !== 0) throw new Error(`Git push exited with code ${pushCode}`);
  return { state, pushed: true, recordedStateSha };
}
