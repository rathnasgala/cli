#!/usr/bin/env node
import { UsageError, parseArguments } from './cli/args.js';
import { CLI_INVOCATION, cliCommand } from './cli/invocation.js';
import { createTerminal } from './cli/terminal.js';
import { COMMANDS } from './commands-manifest.js';


const [name, ...argv] = process.argv.slice(2);
const terminal = createTerminal();

if (name == null || name === 'help' || name === '--help' || name === '-h') {
  usage();
  process.exit(name == null ? 1 : 0);
}

const command = COMMANDS[name];
if (command == null) {
  terminal.fail(`there is no ${name} command`);
  usage();
  process.exit(1);
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`\n  ${command.usage ?? cliCommand(name)}\n  ${command.summary}\n`
    + (command.help == null ? '\n' : `\n${command.help}\n\n`));
  process.exit(0);
}

try {
  const options = parseArguments(argv, { flags: command.flags ?? [], switches: command.switches ?? [] });
  await command.run({ terminal, options });
} catch (failure) {
  report(failure);
  process.exit(1);
}

/**
 * One line the writer can act on.
 *
 * A rejected top-level await prints a stack through node_modules by default, which buries the only
 * line that matters. The stack is still there behind GALA_DEBUG for anyone debugging the CLI
 * itself, which is a different audience from anyone trying to publish.
 */
function report(failure) {
  if (process.env.GALA_DEBUG) {
    process.stderr.write(`${failure instanceof Error ? failure.stack : String(failure)}\n`);
    return;
  }
  terminal.fail(failure instanceof Error ? failure.message : String(failure));
  // Captured output from a subprocess is the most useful thing on screen at exactly this moment.
  if (typeof failure?.detail === 'string' && failure.detail !== '') {
    for (const line of failure.detail.split('\n')) terminal.note(line);
  }
  if (failure instanceof UsageError) usage();
}

function usage() {
  const lines = Object.entries(COMMANDS)
    .map(([key, { summary }]) => `    ${key.padEnd(9)} ${summary}`)
    .join('\n');
  process.stdout.write(`\n  ${CLI_INVOCATION} <command>\n\n${lines}\n\n`
    + `    Run ${CLI_INVOCATION} <command> --help for details.\n\n`);
}
