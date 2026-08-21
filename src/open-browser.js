import { spawn } from 'node:child_process';

/**
 * Opens a URL in the writer's browser, best effort.
 *
 * Printing "Open https://…" and a code asks someone to copy a URL out of a terminal by hand, three
 * times over in one scaffold. The URL is still always printed — this only saves the copying, and it
 * has to keep working when it cannot: over SSH, in a container, in CI, on a machine with no browser
 * at all. So nothing here is allowed to fail the command.
 *
 * Deliberately not attempted when there is no terminal. A CI job that silently spawns a browser
 * process is a hang waiting to happen, and there is nobody there to look at it.
 */
export function openInBrowser(url, {
  platform = process.platform,
  environment = process.env,
  interactive = process.stdin.isTTY === true,
  spawnProcess = spawn
} = {}) {
  if (!interactive) return false;
  // Respected by convention across CLI tooling, and the escape hatch for anyone who does not want
  // their browser taken over.
  if (environment.GALA_NO_BROWSER || environment.CI || environment.NO_BROWSER) return false;
  if (!/^https:\/\//.test(url)) return false;

  const [command, args] = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  try {
    const child = spawnProcess(command, args, { stdio: 'ignore', detached: true, shell: false });
    // Without this the CLI waits for the browser to exit before it can finish.
    child.unref?.();
    // A missing opener is an ordinary outcome on a headless box, not something to report.
    child.on?.('error', () => {});
    return true;
  } catch {
    return false;
  }
}
