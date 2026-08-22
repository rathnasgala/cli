import { galaCredential } from '../auth/gala.js';
import { githubCredential } from '../auth/github.js';

/**
 * Signs in to both, and says so.
 *
 * Not a prerequisite the writer has to remember: every command that needs a credential obtains one.
 * This exists for the times they want to do it deliberately — a new machine, a different account,
 * or after a token has expired.
 */
export async function auth({ terminal, options }) {
  const gala = await galaCredential({ terminal, apiBaseUrl: options.value('api-base-url') });
  const github = await githubCredential({ terminal });

  terminal.blank();
  terminal.done(`Gala   — valid until ${new Date(gala.expiresAt).toLocaleString()}`);
  terminal.done(github.expiresAt
    ? `GitHub — valid until ${new Date(github.expiresAt).toLocaleString()}`
    : 'GitHub — signed in');
}
