import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { cliCommand } from '../cli/invocation.js';
import { createGit } from '../git.js';

/**
 * Answers "why is this not working" without the writer having to know where to look.
 *
 * Every check reports one of three things and never guesses between them: it is fine, it is wrong
 * and here is the fix, or it could not be determined. That third state is the one v0 kept
 * collapsing into the second - an unreachable GitHub reported as "the App is not installed" sent
 * writers to install something that was already installed, repeatedly.
 */
export async function doctor({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const checks = [];

  let selected;
  checks.push(await checkCredential('Account profile', async () => {
    const account = await accountForCommand(options, root, { terminal });
    selected = await authenticatedProfile({ name: account, terminal });
    return ok(`${account}: Gala ${selected.metadata.gala.email} + GitHub @${selected.metadata.githubLogin}`);
  }));

  checks.push(await checkCredential('Gala sign-in', async () => {
    if (selected == null) throw new Error('account profile is unavailable');
    const gala = selected.gala;
    const accepted = await galaApi({ baseUrl: gala.apiBaseUrl, token: gala.accessToken }).accepted();
    return accepted
      ? ok(`valid until ${new Date(gala.expiresAt).toLocaleString()}`)
      : wrong('the API no longer accepts it', cliCommand('auth'));
  }));

  checks.push(await checkCredential('GitHub sign-in', async () => {
    if (selected == null) throw new Error('account profile is unavailable');
    const github = selected.github;
    return ok(github.expiresAt
      ? `valid until ${new Date(github.expiresAt).toLocaleString()}`
      : 'signed in');
  }));

  checks.push(await check('Publication folder', async () => {
    const config = path.join(root, 'site.config.yml');
    await stat(config);
    const posts = await countPosts(root);
    return ok(`${posts} post${posts === 1 ? '' : 's'}`);
  }, 'run this inside a publication, or pass --root'));

  checks.push(await check('Publishing workflow', async () => {
    const workflow = path.join(root, '.github', 'workflows', 'publish.yml');
    const source = await readFile(workflow, 'utf8');
    const siteId = /site-id:\s*([0-9A-Z]{26})/.exec(source)?.[1];
    return siteId == null
      ? wrong('no site id - this publication may not be registered', cliCommand('init'))
      : ok(siteId);
  }, 'the workflow is missing; registration writes it'));

  checks.push(await check('Unsent work', async () => {
    const git = createGit({ root });
    const dirty = await git.run(['status', '--porcelain'], { capture: true });
    const ahead = await git.run(['rev-list', '--count', '@{upstream}..HEAD'], { capture: true, allow: [0, 128] });
    if (dirty !== '') return wrong(`${dirty.split('\n').length} file(s) not recorded`, cliCommand('publish'));
    if (ahead !== '' && ahead !== '0') return wrong(`${ahead} commit(s) not sent`, cliCommand('publish'));
    return ok('everything is on GitHub');
  }, 'this folder is not a git checkout'));

  terminal.blank();
  for (const { name, state, detail, fix } of checks) {
    if (state === 'ok') terminal.done(`${name} - ${detail}`);
    else if (state === 'wrong') terminal.fail(`${name} - ${detail}`);
    else terminal.step(`${name} - could not be determined: ${detail}`);
    if (fix) terminal.note(fix);
  }

  const broken = checks.filter(({ state }) => state === 'wrong');
  if (broken.length > 0) throw new Error(`${broken.length} problem(s) found`);
  terminal.blank();
  terminal.note('Nothing looks wrong.');
}

const ok = (detail) => ({ state: 'ok', detail });
const wrong = (detail, fix) => ({ state: 'wrong', detail, fix });

/** Distinguishes "this is wrong" from "I could not tell", which are different answers. */
async function check(name, run, unknownHint) {
  try {
    return { name, ...await run() };
  } catch (failure) {
    return { name, state: 'unknown', detail: failure.message, fix: unknownHint };
  }
}

/** Credentials are obtained rather than merely inspected, so doctor can also repair a sign-in. */
const checkCredential = check;

async function countPosts(root) {
  try {
    const posts = path.join(root, 'content', 'posts');
    const entries = await readdir(posts, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}
