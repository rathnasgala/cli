import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function javascriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  }));
  return nested.flat();
}

const files = [
  ...await javascriptFiles('scripts'),
  ...await javascriptFiles('src'),
  ...await javascriptFiles('test')
].sort();
const contract = spawnSync(process.execPath, ['scripts/generate-custom-domain.mjs', '--check'], {
  stdio: 'inherit', shell: false,
});
if (contract.error) throw contract.error;
if (contract.status !== 0) process.exit(contract.status ?? 1);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
