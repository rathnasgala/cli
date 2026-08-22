import assert from 'node:assert/strict';
import test from 'node:test';

import { GIT_TOKEN_VARIABLE, gitCredentialArguments, gitEnvironment } from '../src/git-credentials.js';

test('authenticates git as the writer, overriding whatever the machine has configured', () => {
  /*
   * Git used to fall through to the machine's credential helper, which is a different identity from
   * the one the CLI authenticated with. On the machine where this surfaced, the Gala token belonged
   * to `rfai8me` and git's stored credential to `anandrathnas`, so a scaffold created the repository
   * through the API and was then refused when it tried to write to it:
   *
   *     remote: Permission to rfai8me/pub-231254.git denied to anandrathnas
   */
  const args = gitCredentialArguments('ghu_secret');
  // The empty helper comes first: without it the machine's keychain answers before ours does.
  assert.equal(args[0], '-c');
  assert.equal(args[1], 'credential.helper=');
  assert.match(args[3], /username=x-access-token/);
  assert.ok(args[3].includes(`$${GIT_TOKEN_VARIABLE}`), args[3]);
});

test('never puts the token in the argument list, where any process can read it', () => {
  // Arguments are visible machine-wide through `ps`; another process's environment is not.
  const args = gitCredentialArguments('ghu_secret');
  assert.ok(!args.some((argument) => argument.includes('ghu_secret')), args.join(' '));
  assert.equal(gitEnvironment('ghu_secret', {})[GIT_TOKEN_VARIABLE], 'ghu_secret');
});

test('refuses to hang on a terminal prompt when the credential is rejected', () => {
  assert.equal(gitEnvironment('ghu_secret', {}).GIT_TERMINAL_PROMPT, '0');
});

test('without a token it changes nothing, so anonymous clones still work', () => {
  assert.deepEqual(gitCredentialArguments(undefined), []);
  assert.deepEqual(gitCredentialArguments(''), []);
  const environment = { PATH: '/usr/bin' };
  assert.equal(gitEnvironment(undefined, environment), environment);
});
