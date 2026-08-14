import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ACTION_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@v(?:[1-9][0-9]*|[0-9]+\.[0-9]+\.[0-9]+)$/;
const BRANCH = /^(?![./])(?!.*\.\.)(?!.*[~^:?*\[\\])[A-Za-z0-9._/-]+(?<![/.])$/;

export function deriveNightlySchedule(siteId) {
  if (typeof siteId !== 'string' || siteId.trim() === '') throw new TypeError('siteId is required');
  const digest = createHash('sha256').update(siteId, 'utf8').digest();
  return { minute: digest.readUInt16BE(0) % 60, hour: digest.readUInt16BE(2) % 24 };
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new TypeError(`Invalid IANA timezone: ${timezone}`);
  }
}

export async function writePublishWorkflow({
  root,
  siteId,
  timezone,
  actionRef = 'rathnasgala/publish/.github/workflows/publish.yml@v1',
  defaultBranch = 'main',
  buildMode = 'build-and-deploy'
}) {
  validateTimezone(timezone);
  if (!ACTION_REF.test(actionRef)) {
    throw new TypeError('actionRef must pin a reusable workflow to a major or immutable semver tag');
  }
  if (!BRANCH.test(defaultBranch)) throw new TypeError('Invalid default branch');
  if (!['build-only', 'build-and-deploy'].includes(buildMode)) throw new TypeError('Invalid build mode');

  const resolvedRoot = path.resolve(root);
  const templatePath = path.join(resolvedRoot, '.gala', 'publish.yml.template');
  const target = path.join(resolvedRoot, '.github', 'workflows', 'publish.yml');
  const templateMetadata = await lstat(templatePath);
  if (!templateMetadata.isFile() || templateMetadata.isSymbolicLink()) {
    throw new TypeError('Workflow template must be a regular file');
  }
  try {
    const targetMetadata = await lstat(target);
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
      throw new TypeError('Workflow target must be a regular file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const { minute, hour } = deriveNightlySchedule(siteId);
  const workflow = (await readFile(templatePath, 'utf8'))
    .replaceAll('__DEFAULT_BRANCH__', defaultBranch)
    .replaceAll('__CRON__', `${minute} ${hour} * * *`)
    .replaceAll('__TIMEZONE__', timezone)
    .replaceAll('__SITE_ID__', siteId)
    .replaceAll('__ACTION_REF__', actionRef)
    .replaceAll('__BUILD_MODE__', buildMode);
  if (/__[A-Z_]+__/.test(workflow)) throw new TypeError('Workflow template contains unresolved placeholders');

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.gala-workflow-${process.pid}`;
  const backup = `${target}.gala-backup-${process.pid}`;
  let backedUp = false;
  try {
    await writeFile(temporary, workflow, { flag: 'wx' });
    try {
      await rename(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (backedUp) await rename(backup, target);
      throw error;
    }
    if (backedUp) await rm(backup);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { target, minute, hour };
}
