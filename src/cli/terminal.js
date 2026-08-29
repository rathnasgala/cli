import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

/**
 * Everything the writer sees or is asked, in one place.
 *
 * v0 wrote to stdout from a dozen modules with no shared shape, so a scaffold emitted raw git
 * output, bare status codes and half-sentences in whatever order they happened to occur. The
 * failure mode that cost the most was subtler: prompts and browser launches were decided
 * separately in each module, so behaviour with no terminal attached varied by code path - some
 * hung, some crashed, some silently skipped.
 *
 * One object, created once, knows whether there is a terminal. Nothing else has to ask.
 */
export function createTerminal({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  environment = process.env,
  spawnProcess = spawn
} = {}) {
  const interactive = input.isTTY === true && output.isTTY === true;
  const plain = !interactive || environment.NO_COLOR != null || environment.TERM === 'dumb';
  const paint = (code, text) => (plain ? text : `\u001b[${code}m${text}\u001b[0m`);

  return {
    interactive,

    /** A step that is happening now. */
    step: (message) => output.write(`  ${paint('90', '·')} ${message}\n`),

    /** A step that finished. */
    done: (message) => output.write(`  ${paint('32', '✓')} ${message}\n`),

    /** The thing the writer wanted, at the end. */
    result: (message) => output.write(`\n  ${paint('1', message)}\n`),

    note: (message) => output.write(`    ${paint('90', message)}\n`),

    blank: () => output.write('\n'),

    fail: (message) => errorOutput.write(`\n  ${paint('31', 'x')} ${message}\n\n`),

    /**
     * Asks a question, or refuses to.
     *
     * Returning a default without a terminal is what keeps CI honest: a prompt that silently
     * resolves to a guess is worse than one that stops and names the flag to pass instead.
     */
    async ask(question, { fallback } = {}) {
      if (!interactive) {
        if (fallback !== undefined) return fallback;
        throw new Error(`${question} - no terminal to ask; pass it as an option instead`);
      }
      const reader = createInterface({ input, output });
      try {
        const answer = await reader.question(`  ${paint('36', '?')} ${question} `);
        return answer.trim();
      } finally {
        reader.close();
      }
    },

    /** Waits for the writer to finish something in a browser. */
    async waitForEnter(message) {
      if (!interactive) return false;
      await this.ask(`${message} (press enter)`);
      return true;
    },

    /**
     * Opens a URL, best effort, and always prints it.
     *
     * Never attempted without a terminal: a CI job spawning a browser is a hang waiting to happen
     * and there is nobody there to look at it. The URL is printed either way, because it is the
     * thing a writer moves to another device.
     */
    openUrl(url) {
      const opened = interactive
        && environment.CI == null
        && environment.NO_BROWSER == null
        && environment.GALA_NO_BROWSER == null
        && /^https:\/\//.test(url)
        && launch(url, spawnProcess);
      output.write(`    ${paint('90', opened ? 'opened' : 'open')} ${paint('4', url)}\n`);
      return opened;
    }
  };
}

function launch(url, spawnProcess) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.unref?.();
    // A machine with no opener is an ordinary outcome, not something to report.
    child.on?.('error', () => {});
    return true;
  } catch {
    return false;
  }
}
