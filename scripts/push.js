import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Releases whatever version package.json declares, bumping only when it has already shipped.
 *
 * This used to bump the patch unconditionally, which is right for the ordinary case and wrong for
 * every deliberate version. Setting `1.0.0` by hand and running this produced `1.0.1`, with no
 * `1.0.0` on npm at all — the release you meant to make would simply not exist, and nothing would
 * say so.
 *
 * The tag is the record of what has shipped, so it decides: an untagged version is one nobody has
 * released yet and is used as written; a tagged one has, so the patch moves. No extra option to
 * remember, and the deliberate case is the one that needs no thought.
 */
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

function capture(command, args) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], shell: false });
  if (result.error) throw result.error;
  return (result.stdout ?? '').toString().trim();
}

execute(process.execPath, [npmExecutable, 'test']);
execute(process.execPath, [npmExecutable, 'run', 'lint']);

const declared = JSON.parse(readFileSync('package.json', 'utf8')).version;
const alreadyReleased = capture('git', ['tag', '--list', `v${declared}`]) !== '';
if (alreadyReleased) {
  execute(process.execPath, [
    npmExecutable, 'version', 'patch', '--no-git-tag-version', '--ignore-scripts'
  ]);
} else {
  process.stdout.write(`Releasing ${declared} as declared; it has no tag yet.\n`);
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const commitMessage = messages[0].replaceAll('%s', version);
const tag = `v${version}`;

execute('git', ['add', '.']);
execute('git', ['commit', '-m', commitMessage]);
execute('git', ['tag', tag]);
execute('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${tag}`]);
