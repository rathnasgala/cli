import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminal } from '../src/cli/terminal.js';

function capture({ tty = false, environment = {} } = {}) {
  const written = [];
  const stream = { isTTY: tty, write: (text) => { written.push(text); return true; } };
  const spawned = [];
  const terminal = createTerminal({
    input: { isTTY: tty },
    output: stream,
    errorOutput: stream,
    environment,
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      return { unref() {}, on() {} };
    }
  });
  return { terminal, written, spawned, text: () => written.join('') };
}

test('never prompts without a terminal, and says which option to pass instead', async () => {
  /*
   * A prompt that silently resolves to a guess is worse than one that stops: in CI it would pick a
   * name nobody chose and create a repository under it. v0 decided this separately in each module,
   * so behaviour with no terminal varied by code path - some hung, some crashed, some skipped.
   */
  const { terminal } = capture();
  assert.equal(terminal.interactive, false);
  await assert.rejects(terminal.ask('What should this be called?'), /no terminal to ask/);
  assert.equal(await terminal.ask('Which?', { fallback: 'given' }), 'given');
  assert.equal(await terminal.waitForEnter('Once done'), false);
});

test('never launches a browser without a terminal, but always prints the address', () => {
  const { terminal, spawned, text } = capture();
  assert.equal(terminal.openUrl('https://github.com/login/device'), false);
  assert.deepEqual(spawned, []);
  assert.match(text(), /https:\/\/github\.com\/login\/device/);
});

test('respects the opt-outs and refuses anything that is not https', () => {
  for (const environment of [{ CI: '1' }, { NO_BROWSER: '1' }, { GALA_NO_BROWSER: '1' }]) {
    const { terminal, spawned } = capture({ tty: true, environment });
    assert.equal(terminal.openUrl('https://example.com/x'), false);
    assert.deepEqual(spawned, []);
  }
  const { terminal, spawned } = capture({ tty: true });
  // The value reaches a process argument, so a non-https scheme never gets that far.
  for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(terminal.openUrl(url), false);
  }
  assert.deepEqual(spawned, []);
});

test('a launched browser never holds the CLI open', () => {
  const { terminal, spawned } = capture({ tty: true });
  assert.equal(terminal.openUrl('https://example.com/x'), true);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, 'ignore');
  assert.equal(spawned[0].options.shell, false);
});

test('emits no colour when there is no terminal, or when asked not to', () => {
  // Escape sequences in a log file or a CI transcript are noise nobody can read.
  const piped = capture();
  piped.terminal.done('done');
  assert.doesNotMatch(piped.text(), /\u001b/);

  for (const environment of [{ NO_COLOR: '1' }, { TERM: 'dumb' }]) {
    const plain = capture({ tty: true, environment });
    plain.terminal.done('done');
    assert.doesNotMatch(plain.text(), /\u001b/);
  }

  const coloured = capture({ tty: true });
  coloured.terminal.done('done');
  assert.match(coloured.text(), /\u001b/);
});
