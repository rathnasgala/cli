import { regenerateBuildManifest } from '@rathnasgala/content-validation';

/**
 * Content validation, shared by preview and publish.
 *
 * v0 exposed this as its own `validate` command and then called it from two others, so a writer had
 * three ways to learn the same thing and one of them — the pre-push hook — ran it behind their back.
 * Validation is not a task; it is a precondition of showing or shipping. It runs where those happen
 * and nowhere else.
 *
 * `regenerate` is injectable because the real validator compares the configuration against the
 * theme package installed in the publication's node_modules. That belongs in a test of the
 * validator, not of how this reports what it found.
 */
export async function checkContent({ terminal, root, today, regenerate = regenerateBuildManifest }) {
  const { results } = await regenerate({ root, today });
  const failed = results.filter(({ errors }) => errors.length > 0);

  for (const result of results) {
    for (const warning of result.warnings ?? []) terminal.note(`${result.file}: ${warning}`);
  }
  if (failed.length === 0) return results;

  // Every problem, in one pass. Stopping at the first means fixing one thing, running again, and
  // only then learning about the next.
  terminal.blank();
  for (const result of failed) {
    for (const error of result.errors) terminal.fail(`${result.file}: ${error}`);
  }
  throw new Error(`${failed.length} post${failed.length === 1 ? '' : 's'} cannot be published yet`);
}
