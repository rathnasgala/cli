import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageError, parseArguments } from '../src/cli/args.js';

const spec = { flags: ['name', 'root'], switches: ['force'] };

test('reads both --name value and --name=value', () => {
  assert.equal(parseArguments(['--name', 'notes'], spec).value('name'), 'notes');
  assert.equal(parseArguments(['--name=notes'], spec).value('name'), 'notes');
  // Only the first `=` separates, so a value may contain one.
  assert.equal(parseArguments(['--name=a=b'], spec).value('name'), 'a=b');
});

test('refuses an unknown option instead of ignoring it', () => {
  /*
   * v0 read options with `indexOf` at each use site, so a mistyped flag was silently dropped and
   * the command did something other than what was asked, with no indication why.
   */
  assert.throws(() => parseArguments(['--mode', 'x'], spec), UsageError);
  assert.throws(() => parseArguments(['--nmae', 'x'], spec), /unknown option --nmae/);
});

test('refuses a repeated option rather than picking one silently', () => {
  assert.throws(() => parseArguments(['--name', 'a', '--name', 'b'], spec), /more than once/);
});

test('refuses a flag with no value, including one swallowed by the next flag', () => {
  assert.throws(() => parseArguments(['--name'], spec), /needs a value/);
  assert.throws(() => parseArguments(['--name', '--force'], spec), /needs a value/);
});

test('switches are present or absent, never valued', () => {
  assert.equal(parseArguments(['--force'], spec).on('force'), true);
  assert.equal(parseArguments([], spec).on('force'), false);
  assert.throws(() => parseArguments(['--force=yes'], spec), /takes no value/);
});

test('keeps positional arguments in order', () => {
  const options = parseArguments(['A durable idea', '--root', '/site', 'second'], spec);
  assert.deepEqual(options.positional, ['A durable idea', 'second']);
  assert.equal(options.value('root'), '/site');
});
