import assert from 'node:assert/strict';
import test from 'node:test';

import { reportCreatedPublication } from '../src/commands/init.js';

test('init completion reports an unverified deployment without advertising the site as live', () => {
  const output = captureCompletion({
    owner: 'writer',
    name: 'field-notes',
    directoryLabel: 'field-notes'
  });

  assert.match(output, /Created writer\/field-notes/);
  assert.match(output, /first deployment is running in GitHub Actions/i);
  assert.match(output, /https:\/\/github\.com\/writer\/field-notes\/actions/);
  assert.doesNotMatch(output, /https:\/\/writer\.github\.io\/field-notes/);
});

test('init completion prints executable zero-install next steps and explains them', () => {
  const output = captureCompletion({
    owner: 'writer',
    name: 'field-notes',
    directoryLabel: 'field-notes'
  });

  assert.match(output, /cd field-notes/);
  assert.match(output, /npx --yes @rathnasgala\/cli@latest new "Your first post"/);
  assert.match(output, /creates a local Markdown draft; it does not publish/i);
  assert.match(output, /npx --yes @rathnasgala\/cli@latest preview/);
  assert.match(output, /builds and serves the publication locally/i);
  assert.match(output, /npx --yes @rathnasgala\/cli@latest publish/);
  assert.match(output, /checks and sends the work to GitHub/i);
  assert.match(output, /npx --yes @rathnasgala\/cli@latest --help/);
  assert.match(output, /lists every available command/i);
  assert.doesNotMatch(output, /^\s*gala\s/m);
});

test('init completion does not print cd dot when initialized in the current directory', () => {
  const output = captureCompletion({ owner: 'writer', name: 'notes', directoryLabel: '.' });

  assert.doesNotMatch(output, /^\s*cd \.$/m);
  assert.match(output, /npx --yes @rathnasgala\/cli@latest new/);
});

test('init completion shell-quotes a destination containing spaces', () => {
  const output = captureCompletion({
    owner: 'writer', name: 'field-notes', directoryLabel: 'Writing projects/field notes'
  });

  assert.match(output, /cd 'Writing projects\/field notes'/);
});

function captureCompletion(details) {
  const lines = [];
  const terminal = {
    done(message) { lines.push(`done:${message}`); },
    result(message) { lines.push(message); },
    note(message) { lines.push(message); },
    blank() { lines.push(''); }
  };
  reportCreatedPublication({ terminal, ...details });
  return lines.join('\n');
}
