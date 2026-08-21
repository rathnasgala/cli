import assert from 'node:assert/strict';
import test from 'node:test';

import { openInBrowser } from '../src/open-browser.js';

function recorder() {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push([command, args, options]);
    return { unref() {}, on() {} };
  };
  return { calls, spawnProcess };
}

test('uses the platform opener and never blocks the CLI on the browser', () => {
  for (const [platform, command] of [['darwin', 'open'], ['linux', 'xdg-open'], ['win32', 'cmd']]) {
    const { calls, spawnProcess } = recorder();
    const opened = openInBrowser('https://github.com/login/device', {
      platform, environment: {}, interactive: true, spawnProcess
    });
    assert.equal(opened, true);
    assert.equal(calls[0][0], command);
    assert.ok(calls[0][1].includes('https://github.com/login/device'));
    // Detached and stdio-ignored, or the CLI waits for the browser to close.
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0][2].stdio, 'ignore');
    assert.equal(calls[0][2].shell, false);
  }
});

test('does nothing without a terminal, so CI never spawns a browser it cannot use', () => {
  const { calls, spawnProcess } = recorder();
  assert.equal(openInBrowser('https://example.com/x', {
    platform: 'darwin', environment: {}, interactive: false, spawnProcess
  }), false);
  assert.deepEqual(calls, []);
});

test('respects the opt-outs', () => {
  for (const environment of [{ CI: 'true' }, { GALA_NO_BROWSER: '1' }, { NO_BROWSER: '1' }]) {
    const { calls, spawnProcess } = recorder();
    assert.equal(openInBrowser('https://example.com/x', {
      platform: 'darwin', environment, interactive: true, spawnProcess
    }), false);
    assert.deepEqual(calls, []);
  }
});

test('refuses anything that is not an https URL', () => {
  // The value reaches a process argument, so a non-https scheme is never handed to the shell-less
  // opener regardless of where it came from.
  for (const url of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', '']) {
    const { calls, spawnProcess } = recorder();
    assert.equal(openInBrowser(url, {
      platform: 'darwin', environment: {}, interactive: true, spawnProcess
    }), false);
    assert.deepEqual(calls, []);
  }
});

test('a machine with no opener installed is not a failure', () => {
  assert.equal(openInBrowser('https://example.com/x', {
    platform: 'linux', environment: {}, interactive: true,
    spawnProcess: () => { throw new Error('ENOENT'); }
  }), false);
});
