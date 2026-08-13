import { spawn } from 'node:child_process';

function run(root, args, spawnProcess, acceptedExitCodes = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, ...args], { cwd: root, shell: false, stdio: 'inherit' });
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

export async function commitScaffold(root, { spawnProcess = spawn } = {}) {
  await run(root, ['add', '--', 'site.config.yml', '.github/workflows/publish.yml'], spawnProcess);
  const unchanged = await run(root, ['diff', '--cached', '--quiet', '--exit-code'], spawnProcess, [0, 1]);
  if (unchanged === 1) {
    await run(root, ['commit', '-m', 'chore(gala): configure site'], spawnProcess);
  }
  await run(root, ['push', 'origin', 'HEAD'], spawnProcess);
  const commitSha = await capture(root, ['rev-parse', 'HEAD'], spawnProcess);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Git returned an invalid scaffold commit SHA');
  return commitSha;
}
