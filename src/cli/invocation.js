export const CLI_INVOCATION = 'npx --yes @rathnasgala/cli@latest';

export function cliCommand(argumentsText = '') {
  return argumentsText === '' ? CLI_INVOCATION : `${CLI_INVOCATION} ${argumentsText}`;
}

export function shellArgument(value) {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
