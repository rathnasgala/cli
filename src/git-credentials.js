/**
 * Git operations authenticated as the writer's Gala credential, not as the machine.
 *
 * Every git call used to fall through to whatever credential helper the machine had configured,
 * which is a different identity from the one the CLI just authenticated with. On this machine the
 * token belonged to `rfai8me` and git's stored credential to `anandrathnas`, so a scaffold created
 * the repository through the API and was then refused its own push:
 *
 *     remote: Permission to rfai8me/pub-231254.git denied to anandrathnas
 *
 * The OAuth App hid this because both identities were usually the same person. A writer with none
 * configured at all — a fresh machine, or someone who only uses SSH — had no chance.
 *
 * The token is passed through the environment rather than the argument list, because arguments are
 * visible to every process on the machine via `ps`, and written nowhere: an ephemeral `-c` helper
 * leaves no trace in `.git/config`.
 */
export const GIT_TOKEN_VARIABLE = 'GALA_GIT_TOKEN';

/** Clears inherited helpers first, or the machine's keychain answers before ours does. */
export function gitCredentialArguments(accessToken) {
  if (typeof accessToken !== 'string' || accessToken === '') return [];
  return [
    '-c', 'credential.helper=',
    '-c', `credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$${GIT_TOKEN_VARIABLE}"; }; f`
  ];
}

export function gitEnvironment(accessToken, environment = process.env) {
  if (typeof accessToken !== 'string' || accessToken === '') return environment;
  return {
    ...environment,
    [GIT_TOKEN_VARIABLE]: accessToken,
    // Nothing on this path may block waiting for a username at a terminal.
    GIT_TERMINAL_PROMPT: '0'
  };
}
