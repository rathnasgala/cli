import { auth } from './commands/auth.js';
import { doctor } from './commands/doctor.js';
import { domain } from './commands/domain.js';
import { init } from './commands/init.js';
import { createPost } from './commands/new.js';
import { preview } from './commands/preview.js';
import { publish } from './commands/publish.js';
import { prism } from './commands/prism.js';
import { upgrade } from './commands/upgrade.js';
import { cliCommand } from './cli/invocation.js';

/**
 * Commands in the order a writer meets them.
 *
 * v0 had fifteen, and the extra nine were the ones nobody could keep working: a `validate` a hook
 * ran behind the writer's back, a `workflow` writer for a file the server owns, a
 * `record-deployment` nothing called, a `configure` duplicating options another command took.
 * Each was a surface to keep correct and a way to be wrong.
 *
 * This lives apart from the dispatcher so the README can be checked against it. v0's README
 * outlived its commands by weeks - it taught a command that never existed - because nothing tied
 * the two together.
 *
 * Each entry carries its own options. Nothing is parsed globally, so an option cannot mean two
 * things in two places, which is how one ended up read twice with different defaults.
 */
export const COMMANDS = {
  auth: {
    summary: 'Sign in to Gala and GitHub',
    flags: ['api-base-url'],
    run: auth
  },
  init: {
    summary: 'Create a publication in an empty directory',
    usage: cliCommand('init [directory] [--name my-notes] [--domain blog.example.com]'),
    flags: ['name', 'domain', 'api-base-url'],
    run: init
  },
  domain: {
    summary: 'Inspect or change this publication’s custom domain',
    usage: cliCommand('domain [status|set <hostname>|check|cancel|remove] [--root path]'),
    flags: ['root', 'api-base-url'],
    run: domain
  },
  new: {
    summary: 'Start a post',
    usage: cliCommand('new "A durable idea" [--language en]'),
    flags: ['root', 'language', 'today'],
    run: createPost
  },
  preview: {
    summary: 'Build and serve the publication locally',
    flags: ['root', 'today'],
    run: preview
  },
  publish: {
    summary: 'Check, record and send your work to GitHub',
    flags: ['root', 'today'],
    switches: ['skip-checks'],
    run: publish
  },
  prism: {
    summary: 'Manage author-approved Prism configurations',
    usage: cliCommand('prism <status|mode|link-policy|list|create|edit|generate|submit|approve|reject|revoke> [arguments]'),
    flags: ['root', 'api-base-url', 'language', 'depth', 'intent', 'modality', 'file', 'reason'],
    switches: ['yes'],
    run: prism
  },
  upgrade: {
    summary: 'Inspect and apply a verified managed-theme update',
    usage: cliCommand('upgrade [--channel latest|next] [--yes]'),
    flags: ['root', 'channel'],
    switches: ['yes'],
    run: upgrade
  },
  doctor: {
    summary: 'Check a publication and say what is wrong',
    flags: ['root', 'api-base-url'],
    run: doctor
  }
};
