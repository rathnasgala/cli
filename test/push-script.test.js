import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('../scripts/push.js', import.meta.url), 'utf8');

test('releases a deliberate version as written, and only bumps one that already shipped', () => {
  /*
   * The bump used to be unconditional, which is right for the ordinary case and wrong for every
   * deliberate version: setting 1.0.0 by hand and running this produced 1.0.1, with no 1.0.0 on npm
   * at all. The release you meant to make would simply not exist, and nothing would say so.
   *
   * The tag decides, because the tag is the record of what has shipped.
   */
  assert.match(script, /\['tag', '--list', `v\$\{declared\}`\]/);
  assert.match(script, /if \(alreadyReleased\)/);
  assert.match(script, /version['"],\s*['"]patch['"]/);
});

test('never publishes something the suite has not passed', () => {
  // A release that runs the tests afterwards is a release that can ship a failure.
  const publishAt = script.indexOf("'tag', tag");
  assert.ok(script.indexOf("'test'") < publishAt, 'tests must gate the tag');
  assert.ok(script.indexOf("'lint'") < publishAt, 'lint must gate the tag');
});

test('tags and pushes atomically, so a tag never exists without its commit', () => {
  assert.match(script, /--atomic/);
  assert.match(script, /refs\/tags\//);
});

test('refuses to run without a commit message', () => {
  assert.match(script, /messages\.length !== 1/);
});
