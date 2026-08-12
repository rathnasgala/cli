#!/usr/bin/env node

import { parseScaffoldOptions } from './scaffold-options.js';
import { regenerateBuildManifest } from './validate-command.js';
import { createPost } from './new-command.js';
import {
  diagnoseFramework,
  diagnosePublicationState,
  repairFramework
} from './doctor-command.js';
import { configureSite } from './configure-site.js';
import { previewSite } from './preview-command.js';
import { writePublishWorkflow } from './workflow-command.js';
import { publishSite } from './publish-command.js';
import { installPrePushHook } from './hook-command.js';
import { reportRepositoryLimitWarnings } from './repository-limits.js';
import { recordDeployment } from './record-deployment-command.js';
import { authenticateGala } from './auth-command.js';

const [command, ...args] = process.argv.slice(2);

const recognizedCommands = new Set([
  'auth', 'configure', 'scaffold', 'validate', 'new', 'doctor', 'preview',
  'workflow', 'publish', 'record-deployment', 'hook'
]);
function commandRoot() {
  const rootIndex = args.indexOf('--root');
  if (rootIndex !== -1) return args[rootIndex + 1];
  if (command === 'doctor' || command === 'validate') {
    return args.find((argument, index) =>
      !argument.startsWith('--')
      && !['--today', '--source'].includes(args[index - 1])
    ) ?? process.cwd();
  }
  return process.cwd();
}
if (recognizedCommands.has(command)) {
  await reportRepositoryLimitWarnings(commandRoot());
}

if (command === 'auth') {
  const apiIndex = args.indexOf('--api-base-url');
  const apiBaseUrl = apiIndex === -1 ? 'https://api.gala67.com' : args[apiIndex + 1];
  const result = await authenticateGala({
    apiBaseUrl,
    showInstructions: ({ verificationUri, userCode }) => {
      process.stdout.write(`Open ${verificationUri}\nEnter code: ${userCode}\n`);
    }
  });
  process.stdout.write(`Gala authentication stored securely until ${result.expiresAt.toISOString()}.\n`);
} else if (command === 'scaffold' || command === 'configure') {
  const rootIndex = args.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : args[rootIndex + 1];
  const options = parseScaffoldOptions(args);
  const config = await configureSite(root, options);
  process.stdout.write(`${JSON.stringify(config.design, null, 2)}\n`);
} else if (command === 'validate') {
  const todayIndex = args.indexOf('--today');
  const today = todayIndex === -1 ? undefined : args[todayIndex + 1];
  const root = args.find((argument) => !argument.startsWith('--') && argument !== today) ?? process.cwd();
  const { results } = await regenerateBuildManifest({ root, today });
  const failures = results.filter(({ errors }) => errors.length > 0);

  for (const result of failures) {
    for (const error of result.errors) process.stderr.write(`${result.file}: ${error}\n`);
  }
  for (const result of results) {
    for (const warning of result.warnings) process.stderr.write(`${result.file}: warning: ${warning}\n`);
  }
  process.stdout.write(`Validated ${results.length} post variant(s); ${failures.length} failed.\n`);
  if (failures.length > 0) process.exitCode = 1;
} else if (command === 'new') {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const title = valueFor('--title');
  const language = valueFor('--language');
  const today = valueFor('--today');
  const root = valueFor('--root') ?? process.cwd();
  const result = await createPost({ root, title, language, today });
  process.stdout.write(`Created ${result.postPath}\n`);
} else if (command === 'doctor') {
  const positional = args.filter((argument, index) =>
    !argument.startsWith('--') && args[index - 1] !== '--source'
  );
  const root = positional[0] ?? process.cwd();
  if (args.includes('--fix')) {
    const sourceIndex = args.indexOf('--source');
    const sourceRoot = sourceIndex === -1 ? undefined : args[sourceIndex + 1];
    if (!sourceRoot) throw new Error('doctor --fix requires --source <trusted-template-root>');
    const repaired = await repairFramework(root, sourceRoot);
    process.stdout.write(`Repaired ${repaired.length} managed file(s).\n`);
  }
  const findings = await diagnoseFramework(root);
  const drift = findings.filter(({ status }) => status !== 'intact');
  findings.forEach(({ path: file, status }) => process.stdout.write(`${status}\t${file}\n`));
  const publicationState = await diagnosePublicationState(root);
  process.stdout.write(`${publicationState.status}\t${publicationState.path}\n`);
  if (publicationState.status === 'invalid') process.exitCode = 1;
  if (drift.length > 0) process.exitCode = 1;
} else if (command === 'preview') {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  await previewSite({
    root: valueFor('--root') ?? process.cwd(),
    today: valueFor('--today')
  });
} else if (command === 'workflow') {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const result = await writePublishWorkflow({
    root: valueFor('--root') ?? process.cwd(),
    siteId: valueFor('--site-id'),
    timezone: valueFor('--timezone'),
    actionRef: valueFor('--action-ref'),
    defaultBranch: valueFor('--default-branch') ?? 'main',
    buildMode: valueFor('--mode') ?? 'build-and-deploy'
  });
  process.stdout.write(`Wrote ${result.target} (${result.minute} ${result.hour} * * *)\n`);
} else if (command === 'publish') {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  await publishSite({
    root: valueFor('--root') ?? process.cwd(),
    today: valueFor('--today'),
    force: args.includes('--force')
  });
} else if (command === 'record-deployment') {
  const valueFor = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const root = valueFor('--root') ?? process.cwd();
  const result = await recordDeployment({
    root,
    deployedOn: valueFor('--today'),
    deployedCommitSha: valueFor('--commit-sha')
  });
  process.stdout.write(
    `${result.pushed ? 'Pushed' : 'No change for'} successful deployment `
    + `of ${result.state.posts.length} article(s).\n`
    + `Recorded state SHA: ${result.recordedStateSha}\n`
  );
} else if (command === 'hook' && args[0] === 'install') {
  const rootIndex = args.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : args[rootIndex + 1];
  const result = await installPrePushHook(root);
  process.stdout.write(`${result.installed ? 'Installed' : 'Already installed'} ${result.target}\n`);
} else {
  process.stderr.write('Usage: gala <auth|configure|scaffold|validate|new|doctor|hook|preview|publish|record-deployment|workflow> [options]\n');
  process.exitCode = 1;
}
