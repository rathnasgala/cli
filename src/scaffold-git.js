import { spawn } from 'node:child_process';

import { gitCredentialArguments, gitEnvironment } from './git-credentials.js';

function run(root, args, spawnProcess, acceptedExitCodes = [0], accessToken) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, ...gitCredentialArguments(accessToken), ...args], {
      cwd: root, shell: false, stdio: 'inherit', env: gitEnvironment(accessToken)
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git ${args[0]} terminated by signal ${signal}`));
      else if (!acceptedExitCodes.includes(code)) reject(new Error(`Git ${args[0]} exited with code ${code}`));
      else resolve(code);
    });
  });
}

function capture(root, args, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, ...args], {
      cwd: root, shell: false, stdio: ['ignore', 'pipe', 'inherit']
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git ${args[0]} terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git ${args[0]} exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Takes the commit registration just pushed, before anything local is written.
 *
 * Registering a site makes the server write `site.config.yml` and `.github/workflows/publish.yml`
 * into the repository. The checkout was taken before that, so the scaffold's own commit lands on a
 * parent the remote has moved past and the push is rejected:
 *
 *     ! [rejected] HEAD -> main (fetch first)
 *
 * Integrating here rather than after committing is what keeps it simple: at this point the working
 * tree is untouched, so the rebase is trivial and cannot conflict with files this process is about
 * to write. A dirty tree — only reachable via --resume — fails loudly, which is the right answer
 * for work nobody asked this command to reconcile.
 */
export async function syncScaffold(root, { spawnProcess = spawn, accessToken } = {}) {
  const branch = await capture(root, ['rev-parse', '--abbrev-ref', 'HEAD'], spawnProcess);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch === 'HEAD') {
    throw new Error('Git checkout is not on a named branch');
  }
  await run(root, ['fetch', 'origin', branch], spawnProcess, [0], accessToken);
  await run(root, ['rebase', `origin/${branch}`], spawnProcess);
  const commitSha = await capture(root, ['rev-parse', 'HEAD'], spawnProcess);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Git returned an invalid head SHA');
  return commitSha;
}

export async function commitScaffold(root, { spawnProcess = spawn, accessToken } = {}) {
  /*
   * Only the site configuration. The publish workflow is written by the server during registration
   * — the same path the browser editor uses — and staging a file that is not in the checkout yet
   * fails outright with a pathspec error.
   */
  await run(root, ['add', '--', 'site.config.yml'], spawnProcess);
  const unchanged = await run(root, ['diff', '--cached', '--quiet', '--exit-code'], spawnProcess, [0, 1]);
  if (unchanged === 1) {
    await run(root, ['commit', '-m', 'chore(gala): configure site'], spawnProcess);
  }
  await run(root, ['push', 'origin', 'HEAD'], spawnProcess, [0], accessToken);
  const commitSha = await capture(root, ['rev-parse', 'HEAD'], spawnProcess);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Git returned an invalid scaffold commit SHA');
  return commitSha;
}
