import path from 'node:path';

import { checkContent } from '../content.js';
import { createGit } from '../git.js';
import { githubCredential } from '../auth/github.js';
import { readPublication } from '../publication.js';

/**
 * Validates, records the writer's work, and sends it to GitHub.
 *
 * v0 only sent — the writer had to remember to record their changes first, and a run that appeared
 * to succeed could ship nothing at all. It also used the machine's git credential rather than the
 * one the CLI holds, which fails for anyone whose accounts differ.
 *
 * The order below is the whole of the difficulty. Every successful publish adds a deployment record
 * to the branch from the workflow, so the checkout is behind by one before the writer has touched
 * anything — catching up is the normal condition, not a race fix. It has to happen *before*
 * validation, because validation assigns a content id to any post missing one and the workflow
 * assigns ids remotely as well; the other order has both sides edit the same file with different
 * ids, which git can only report as a conflict.
 *
 * Publishing itself happens on GitHub: the workflow in the repository builds and deploys. This
 * command's job ends when the work is on the branch.
 */
export async function publish({ terminal, options, cwd = process.cwd(), regenerate }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const today = options.value('today');

  const github = await githubCredential({ terminal });
  const git = createGit({ root, token: github.accessToken });

  terminal.step('Catching up with GitHub');
  await git.takeRemote();

  if (!options.on('skip-checks')) {
    terminal.step('Checking content');
    await checkContent({ terminal, root, today, ...(regenerate == null ? {} : { regenerate }) });
    terminal.done('Content is valid');
  }

  const recorded = await git.record('Publish', ['.']);
  if (!recorded) {
    terminal.done('Nothing new to send');
    return;
  }
  terminal.done('Changes recorded');

  terminal.step('Sending to GitHub');
  await git.send();

  terminal.done('Sent');

  const publication = await readPublication(root);
  if (publication != null) terminal.result(publication.url);
  terminal.blank();
  terminal.note('GitHub is building it now; give it a minute or two.');
}
