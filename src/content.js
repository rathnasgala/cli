import path from 'node:path';

import { regenerateBuildManifest } from '@rathnasgala/content-validation';

function shownPath(root, file) {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : file;
}

/**
 * Content validation, shared by preview and publish.
 *
 * v0 exposed this as its own `validate` command and then called it from two others, so a writer had
 * three ways to learn the same thing and one of them - the pre-push hook - ran it behind their back.
 * Validation is not a task; it is a precondition of showing or shipping. It runs where those happen
 * and nowhere else.
 *
 * `regenerate` is injectable because the real validator compares the configuration against the
 * theme package installed in the publication's node_modules. That belongs in a test of the
 * validator, not of how this reports what it found.
 */
export async function checkContent({
  terminal, root, today, preview = false, regenerate = regenerateBuildManifest
}) {
  const { results } = await regenerate({ root, today, preview });
  const failed = results.filter(({ errors }) => errors.length > 0);

  for (const result of results) {
    for (const warning of result.warnings ?? []) {
      terminal.note(`${shownPath(root, result.file)} - ${warning}`);
    }
  }
  if (failed.length === 0) return results;

  // Every problem, in one pass. Stopping at the first means fixing one thing, running again, and
  // only then learning about the next.
  const details = [];
  for (const result of failed) {
    details.push(shownPath(root, result.file));
    for (const error of result.errors) details.push(`  - ${error}`);
  }
  const problemCount = failed.reduce((count, result) => count + result.errors.length, 0);
  details.push(`Fix ${problemCount === 1 ? 'this problem' : 'these problems'}, then run the command again.`);
  const failure = new Error(
    `Content check failed: ${problemCount} problem${problemCount === 1 ? '' : 's'} `
    + `in ${failed.length} post${failed.length === 1 ? '' : 's'}`
  );
  failure.detail = details.join('\n');
  throw failure;
}
