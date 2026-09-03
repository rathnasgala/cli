import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const systemGit = process.env.GALA_TEST_GIT ?? '/usr/bin/git';
const temporaryRoot = `${path.resolve(tmpdir())}${path.sep}`;

function assertTemporaryRepository(controlledPath) {
  assert.equal(typeof controlledPath, 'string', 'test Git must identify its temporary repository');
  assert.ok(`${path.resolve(controlledPath)}${path.sep}`.startsWith(temporaryRoot),
    `test Git may run only inside ${tmpdir()}`);
}

export function runTemporaryGit(args, options = {}) {
  const controlledPath = options.cwd
    ?? (['-C', '--git-dir'].includes(args[0]) ? args[1] : undefined)
    ?? (['clone', 'init'].includes(args[0]) ? args.at(-1) : undefined);
  assertTemporaryRepository(controlledPath);
  return execute(systemGit, args, options);
}

export function spawnTemporaryGit(command, args, options = {}) {
  assert.equal(command, 'git');
  assertTemporaryRepository(options.cwd);
  return spawn(systemGit, args, options);
}

export function temporaryGitEnvironment(environment, controlledPath) {
  assertTemporaryRepository(controlledPath);
  return {
    ...environment,
    PATH: `${path.dirname(systemGit)}:${environment.PATH ?? ''}`,
  };
}
