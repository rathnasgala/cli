import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { COMMANDS } from '../src/commands-manifest.js';

const authenticatedCommands = ['init', 'domain', 'publish', 'prism', 'theme', 'doctor'];

test('every authenticated command accepts one common account selector', () => {
  for (const name of authenticatedCommands) {
    assert.ok(COMMANDS[name].flags.includes('account'), `${name} omits --account`);
  }
});

test('commands never load Gala and GitHub credentials independently', async () => {
  for (const name of authenticatedCommands) {
    const source = await readFile(new URL(`../src/commands/${name}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /galaCredential|githubCredential/, name);
    if (name === 'init') assert.match(source, /authenticatedProfile/, 'init has no active-profile selection');
    else assert.match(source, /accountForCommand/, `${name} has no checkout-account gate`);
    assert.match(source, /authenticatedProfile/, `${name} bypasses the paired profile`);
  }
});

test('only profile creation may invoke the independent provider sign-in functions', async () => {
  const profiles = await readFile(new URL('../src/auth/profiles.js', import.meta.url), 'utf8');
  assert.match(profiles, /galaSignIn = galaCredential/);
  assert.match(profiles, /githubSignIn = githubCredential/);
  assert.match(profiles, /githubLogin\.toLowerCase\(\)/);
});

test('the checkout binding is private Git metadata, never publication content', async () => {
  const source = await readFile(new URL('../src/auth/checkout-profile.js', import.meta.url), 'utf8');
  assert.match(source, /'\.git'/);
  assert.doesNotMatch(source, /\.gala/);
  assert.match(source, /cannot override it/);
});
