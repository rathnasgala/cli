import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../cli/args.js';
import { requireProfileName } from './profiles.js';

const FILENAME = 'gala-account-profile';

export async function bindCheckoutProfile(root, name) {
  const gitDirectory = path.join(path.resolve(root), '.git');
  const metadata = await stat(gitDirectory).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new Error('Cannot bind the account profile because this is not a standard Git checkout.');
  }
  const target = path.join(gitDirectory, FILENAME);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${requireProfileName(name)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}

export async function checkoutProfile(root) {
  try {
    return requireProfileName((await readFile(
      path.join(path.resolve(root), '.git', FILENAME), 'utf8'
    )).trim());
  } catch (failure) {
    if (failure?.code === 'ENOENT') return null;
    throw failure;
  }
}

export async function accountForCommand(options, root) {
  const explicit = options.value('account');
  const bound = await checkoutProfile(root);
  if (explicit != null) {
    const selected = requireProfileName(explicit);
    if (bound != null && bound !== selected) {
      throw new UsageError(
        `This checkout belongs to account profile ${bound}; --account ${selected} cannot override it.`
      );
    }
    return selected;
  }
  if (bound != null) return bound;
  throw new UsageError('This checkout has no account profile binding; pass --account <github-login>.');
}
