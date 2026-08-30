import { addProfile, listProfiles, removeProfile, useProfile } from '../auth/profiles.js';
import { UsageError } from '../cli/args.js';

/**
 * Signs in to both, and says so.
 *
 * One login creates and activates the GitHub-named pair. A writer returns here only for a new
 * machine, a different account, or an expired token.
 */
export async function auth({ terminal, options }) {
  const [action = 'list', name, ...extra] = options.positional;
  if (extra.length > 0 || !['list', 'add', 'use', 'remove'].includes(action)) {
    throw new UsageError('Use: auth [list|add|use <github-login>|remove <github-login>]');
  }
  if (action === 'list') {
    if (name != null) throw new UsageError('auth list takes no profile name');
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      terminal.note('No account profiles. Run auth add.');
      return [];
    }
    for (const profile of profiles) {
      terminal.done(`${profile.active ? '*' : ' '} ${profile.name}: Gala ${profile.gala.email} + GitHub @${profile.githubLogin}`);
    }
    return profiles;
  }
  if (action === 'add') {
    if (name != null) throw new UsageError('auth add takes no profile name; it uses your GitHub username');
    const profile = await addProfile({ terminal, apiBaseUrl: options.value('api-base-url') });
    terminal.done(`Using ${profile.metadata.name}: Gala ${profile.metadata.gala.email} + GitHub @${profile.metadata.githubLogin}`);
    return profile.metadata;
  }
  if (name == null) throw new UsageError(`auth ${action} needs a GitHub username`);
  if (action === 'use') {
    const profile = await useProfile(name);
    terminal.done(`Using ${name}: Gala ${profile.gala.email} + GitHub @${profile.githubLogin}`);
    return profile;
  }
  await removeProfile(name);
  terminal.done(`Removed account profile ${name}`);
  return null;
}
