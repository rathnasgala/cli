import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const messages = process.argv.slice(2);
if (messages.length !== 1 || messages[0].trim() === '') {
  throw new Error('Usage: npm run push -- "commit message"');
}

const npmExecutable = process.env.npm_execpath;
if (npmExecutable == null || npmExecutable.trim() === '') {
  throw new Error('npm run push must be invoked through npm');
}

function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

execute(process.execPath, [npmExecutable, 'test']);
execute(process.execPath, [npmExecutable, 'run', 'lint']);
execute(process.execPath, [
  npmExecutable, 'version', 'patch', '--no-git-tag-version', '--ignore-scripts'
]);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const commitMessage = messages[0].replaceAll('%s', version);
const tag = `v${version}`;

execute('git', ['add', '.']);
execute('git', ['commit', '-m', commitMessage]);
execute('git', ['tag', tag]);
execute('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`]);
