/**
 * Argument parsing, deliberately small.
 *
 * v0 read arguments with `args.indexOf(name)` at each use site, so a mistyped flag was silently
 * ignored and the same flag could be read twice with different defaults in two places. Parsing
 * once and rejecting anything unrecognised is the difference between a typo that fails immediately
 * and one that quietly changes what the command does.
 */
export function parseArguments(argv, { flags = [], switches = [] } = {}) {
  const values = new Map();
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const [name, inline] = splitOnce(token.slice(2));
    if (switches.includes(name)) {
      if (inline != null) throw new UsageError(`--${name} takes no value`);
      values.set(name, true);
      continue;
    }
    if (!flags.includes(name)) throw new UsageError(`unknown option --${name}`);
    if (values.has(name)) throw new UsageError(`--${name} given more than once`);

    const value = inline ?? argv[index + 1];
    if (value == null || (inline == null && value.startsWith('--'))) {
      throw new UsageError(`--${name} needs a value`);
    }
    if (inline == null) index += 1;
    values.set(name, value);
  }

  return {
    positional,
    value: (name) => (typeof values.get(name) === 'string' ? values.get(name) : undefined),
    on: (name) => values.get(name) === true
  };
}

/** Supports `--name value` and `--name=value`; only the first `=` separates. */
function splitOnce(token) {
  const at = token.indexOf('=');
  return at === -1 ? [token, undefined] : [token.slice(0, at), token.slice(at + 1)];
}

/** How the command was invoked is wrong, as opposed to something failing while it ran. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}
