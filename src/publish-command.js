import path from 'node:path';
import { spawn } from 'node:child_process';
import { regenerateBuildManifest } from './validate-command.js';

export async function publishSite({
  root,
  today,
  force = false,
  spawnProcess = spawn,
  warn = (message) => process.stderr.write(`${message}\n`)
}) {
  const siteRoot = path.resolve(root);
  if (!force) {
    const { results } = await regenerateBuildManifest({ root: siteRoot, today });
    const failures = results.filter(({ errors }) => errors.length > 0);
    if (failures.length > 0) {
      throw new Error(`Publish refused: ${failures.length} post variant(s) failed validation`);
    }
    for (const result of results) {
      for (const warning of result.warnings) warn(`${result.file}: warning: ${warning}`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', siteRoot, 'push'], {
      cwd: siteRoot,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Publish terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Git push exited with code ${code}`));
      else resolve();
    });
  });
}
