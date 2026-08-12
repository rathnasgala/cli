import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = '// Managed by @rathnasgala/cli. Do not edit.\n';
const HOOK = `#!/usr/bin/env node
${MARKER}const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = process.cwd();
const executable = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'gala.cmd' : 'gala'
);
const result = spawnSync(executable, ['validate', '--root', root], {
  cwd: root,
  shell: false,
  stdio: 'inherit'
});
if (result.error) {
  console.error('Gala validation hook failed to start:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;

async function metadata(file, allowMissing = false) {
  try {
    return await lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function installPrePushHook(root) {
  const resolvedRoot = path.resolve(root);
  const gitDirectory = path.join(resolvedRoot, '.git');
  const gitMetadata = await metadata(gitDirectory);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new TypeError('.git must be a real directory');
  }

  const hooksDirectory = path.join(gitDirectory, 'hooks');
  const hooksMetadata = await metadata(hooksDirectory, true);
  if (hooksMetadata?.isSymbolicLink() || (hooksMetadata && !hooksMetadata.isDirectory())) {
    throw new TypeError('.git/hooks must be a real directory');
  }
  if (!hooksMetadata) await mkdir(hooksDirectory);

  const target = path.join(hooksDirectory, 'pre-push');
  const existing = await metadata(target, true);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new TypeError('Existing pre-push hook must be a regular file');
    }
    if (await readFile(target, 'utf8') === HOOK) return { target, installed: false };
    throw new Error('Refusing to overwrite an existing pre-push hook');
  }

  await writeFile(target, HOOK, { encoding: 'utf8', flag: 'wx', mode: 0o755 });
  return { target, installed: true };
}
