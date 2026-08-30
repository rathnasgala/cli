import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * Git, authenticated as the writer's Gala credential rather than as the machine.
 *
 * v0 let every git call fall through to whatever credential helper the machine had configured,
 * which is a different identity from the one the CLI just authenticated with. On the machine where
 * this surfaced the token belonged to one account and git's stored credential to another, so a
 * scaffold created the repository through the API and was then refused when it tried to write to
 * it. Anyone with no credential configured at all - a fresh machine, or SSH-only - had no chance.
 *
 * The token travels in the environment, never in the argument list, because arguments are readable
 * machine-wide through `ps`. Nothing is written to `.git/config`.
 */
const TOKEN_VARIABLE = 'GALA_GIT_TOKEN';

function credentialArguments(token) {
  if (typeof token !== 'string' || token === '') return [];
  return [
    // The empty helper first, or the machine's keychain answers before ours does.
    '-c', 'credential.helper=',
    '-c', `credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$${TOKEN_VARIABLE}"; }; f`
  ];
}

function environmentFor(token) {
  if (typeof token !== 'string' || token === '') return process.env;
  // Nothing on this path may block waiting for a username at a terminal.
  return { ...process.env, [TOKEN_VARIABLE]: token, GIT_TERMINAL_PROMPT: '0' };
}

export function createGit({ root, token, spawnProcess = spawn } = {}) {
  const cwd = root == null ? process.cwd() : path.resolve(root);

  /*
   * Git's own output is captured, not inherited.
   *
   * v0 let it through, so a writer's terminal filled with `Cloning into '/long/path'`, rebase
   * plumbing and push refspecs interleaved with the CLI's own lines. None of it is addressed to
   * them. On failure every captured line is emitted, because that is exactly when git's text is
   * the most useful thing on screen.
   */
  const run = (args, { allow = [0], capture = false, binary = false } = {}) => new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', cwd, ...credentialArguments(token), ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environmentFor(token)
    });
    const stdout = [];
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout.push(Buffer.from(chunk)); });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal || !allow.includes(code)) {
        const said = `${Buffer.concat(stdout).toString('utf8')}${stderr}`.trim();
        const failure = new Error(signal
          ? `git ${args[0]} stopped by ${signal}`
          : `git ${args[0]} exited with ${code}`);
        failure.detail = said;
        reject(failure);
        return;
      }
      const output = Buffer.concat(stdout);
      resolve(capture ? (binary ? output : output.toString('utf8').trim()) : code);
    });
  });

  const git = {
    root: cwd,
    run,

    async branch() {
      const name = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
      if (name === 'HEAD' || !/^[A-Za-z0-9._/-]+$/.test(name)) {
        throw new Error('This checkout is not on a named branch');
      }
      return name;
    },

    async head() {
      const sha = await run(['rev-parse', 'HEAD'], { capture: true });
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('git returned an unusable commit id');
      return sha;
    },

    /** True when something was recorded; false when the tree already matched. */
    async record(message, paths) {
      await run(['add', '--', ...paths]);
      const unchanged = await run(['diff', '--cached', '--quiet', '--exit-code'], { allow: [0, 1] });
      if (unchanged === 0) return false;
      await run(['commit', '-m', message]);
      return true;
    },

    send: () => run(['push', 'origin', 'HEAD']),

    /**
     * Brings the remote's commits in, over the top of anything uncommitted.
     *
     * `--autostash` matters: this runs before the writer's work is recorded, and a rebase refuses a
     * dirty tree. Doing it the other way round - record first, then rebase - lets the publication
     * workflow and the local publish independently update the same file. Taking the remote first
     * makes the post-publish validation pass the sole local writer of any missing content ID.
     */
    async takeRemote() {
      const conflictedPaths = await unmergedPaths(run);
      if (conflictedPaths.length > 0) {
        if (await reconcileManagedThemeConflict(run, cwd, conflictedPaths).catch(() => false)) {
          return git.takeRemote();
        }
        const failure = new Error('Git has unresolved conflicts. Gala left them untouched. Run git '
          + 'status, resolve or abort the operation it reports, then publish again.');
        failure.detail = `Conflicted files:\n${conflictedPaths.join('\n')}`;
        throw failure;
      }
      const branch = await git.branch();
      await run(['fetch', 'origin', branch]);
      await run(['rebase', '--autostash', `origin/${branch}`]);
      const reappliedConflicts = await unmergedPaths(run);
      if (reappliedConflicts.length > 0) {
        if (await reconcileManagedThemeConflict(run, cwd, reappliedConflicts).catch(() => false)) {
          return git.head();
        }
        const failure = new Error('Git updated from GitHub, but could not reapply your local work '
          + 'without conflicts. Gala left every file untouched. Run git status, resolve the named '
          + 'files, git add them, then publish again.');
        failure.detail = `Conflicted files:\n${reappliedConflicts.join('\n')}`;
        throw failure;
      }
      return git.head();
    }
  };

  return git;
}

async function reconcileManagedThemeConflict(run, root, conflictedPaths) {
  const manifestPath = '.gala/managed-files.json';
  if (!conflictedPaths.includes(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse((await run(
      ['show', `:3:${manifestPath}`], { capture: true, binary: true }
    )).toString('utf8'));
  } catch {
    return false;
  }
  if (manifest?.schemaVersion !== 1 || typeof manifest.files !== 'object') return false;
  const managedConflicts = conflictedPaths.filter((entry) => entry !== manifestPath
    && entry !== 'site.config.yml');
  if (managedConflicts.length + 2 !== conflictedPaths.length) return false;
  for (const managed of managedConflicts) {
    const expected = manifest.files[managed];
    if (!/^[0-9a-f]{64}$/.test(expected ?? '')) return false;
    const local = await run(['show', `:3:${managed}`], { capture: true, binary: true });
    if (createHash('sha256').update(local).digest('hex') !== expected) return false;
  }
  const worktreeConfig = await readFile(path.join(root, 'site.config.yml'), 'utf8');
  const resolvedConfig = selectStashedConflictSections(worktreeConfig);
  let configuration;
  try {
    configuration = parse(resolvedConfig);
  } catch {
    return false;
  }
  if (configuration?.framework?.themePackage?.name !== manifest.themePackage?.name
      || configuration?.framework?.themePackage?.version !== manifest.themePackage?.version) return false;
  await run(['checkout', '--theirs', '--', manifestPath, ...managedConflicts]);
  await writeFile(path.join(root, 'site.config.yml'), resolvedConfig);
  await run(['add', '--', ...conflictedPaths]);
  return (await unmergedPaths(run)).length === 0;
}

function selectStashedConflictSections(value) {
  return value.replace(
    /^<<<<<<< Updated upstream\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> Stashed changes\n/gm,
    '$1'
  );
}

async function unmergedPaths(run) {
  const unmerged = await run(
    ['diff', '--name-only', '--diff-filter=U', '-z'], { capture: true }
  );
  return unmerged.split('\0').filter(Boolean);
}

export function cloneRepository({ url, target, token, spawnProcess = spawn }) {
  const resolved = path.resolve(target);
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', [...credentialArguments(token), 'clone', url, resolved], {
      cwd: path.dirname(resolved),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environmentFor(token)
    });
    let said = '';
    child.stdout?.on('data', (chunk) => { said += chunk; });
    child.stderr?.on('data', (chunk) => { said += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal || code !== 0) {
        const failure = new Error(signal ? `clone stopped by ${signal}` : `clone exited with ${code}`);
        failure.detail = said.trim();
        reject(failure);
        return;
      }
      resolve(resolved);
    });
  });
}

/** Populate a deliberately empty git repository without replacing its .git directory. */
export async function populateEmptyRepository({ url, target, token, spawnProcess = spawn }) {
  const git = createGit({ root: target, token, spawnProcess });
  const hasOrigin = await git.run(['remote', 'get-url', 'origin'], { allow: [0, 2] });
  await git.run(hasOrigin === 0
    ? ['remote', 'set-url', 'origin', url]
    : ['remote', 'add', 'origin', url]);
  await git.run(['fetch', 'origin']);
  const remoteHead = await git.run(['ls-remote', '--symref', 'origin', 'HEAD'], { capture: true });
  const branch = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remoteHead)?.[1];
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('GitHub did not report a usable default branch');
  }
  await git.run(['checkout', '-B', branch, '--track', `origin/${branch}`]);
  return path.resolve(target);
}
