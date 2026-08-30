import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { UsageError } from '../cli/args.js';
import { cliCommand } from '../cli/invocation.js';
import { customDomain } from '../domain.js';
import { readPublication } from '../publication.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export async function domain({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const publication = await readPublication(root);
  if (!publication || !ULID.test(publication.siteId ?? '')) {
    throw new UsageError('Run this inside a registered Gala publication, or pass --root.');
  }
  const [action = 'status', value, ...extra] = options.positional;
  if (extra.length > 0 || !['status', 'set', 'check', 'cancel', 'remove'].includes(action)) {
    throw new UsageError(`Use: ${cliCommand('domain [status|set <hostname>|check|cancel|remove]')}`);
  }
  if (action === 'set' && value == null) throw new UsageError('domain set needs a hostname');
  if (action !== 'set' && value != null) throw new UsageError(`domain ${action} takes no hostname`);

  const account = await accountForCommand(options, root, { terminal });
  const credential = (await authenticatedProfile({ name: account, terminal })).gala;
  const api = galaApi({ baseUrl: credential.apiBaseUrl, token: credential.accessToken });

  if (action === 'status') {
    const pending = await api.pendingTopologyChange(publication.siteId);
    if (!pending) {
      terminal.result((await ownedSite(api, publication.siteId)).publicationUrl);
      terminal.note('No domain change is pending.');
      return null;
    }
    showPending(terminal, pending);
    return pending;
  }

  if (action === 'set') {
    const checked = customDomain(value);
    if (checked.error) throw new UsageError(checked.error);
    const change = await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${checked.host}`,
      pathPrefix: '/',
    });
    terminal.done(`Reserved ${checked.host}`);
    terminal.note(`Verify it in the repository owner’s GitHub account, then run: ${cliCommand('domain check')}`);
    terminal.openUrl('https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages');
    return change;
  }

  if (action === 'remove') {
    const existing = await api.pendingTopologyChange(publication.siteId);
    if (existing) {
      throw new UsageError('No second domain change can start while another one is pending; cancel it first.');
    }
    const site = await ownedSite(api, publication.siteId);
    const [owner, repository] = site.repository.split('/');
    const host = `${owner.toLowerCase()}.github.io`;
    const prefix = repository.toLowerCase() === host ? '/' : `/${repository}`;
    const change = await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${host}`,
      pathPrefix: prefix,
    });
    const committed = await api.commitTopologyChange(publication.siteId, change.changeId);
    terminal.done(`Returned to ${committed.canonicalBaseUrl}${prefix === '/' ? '/' : `${prefix}/`}`);
    terminal.note('Remove the old custom-domain records from your DNS provider.');
    return committed;
  }

  const pending = await api.pendingTopologyChange(publication.siteId);
  if (!pending) throw new UsageError('No domain change is pending.');

  if (action === 'cancel') {
    await api.discardTopologyChange(publication.siteId, pending.changeId);
    terminal.done('Cancelled the pending domain change');
    return null;
  }

  if (action === 'check') {
    if (pending.cname && pending.state === 'PREPARED') {
      const configured = await api.configureTopologyChange(publication.siteId, pending.changeId);
      terminal.done(`GitHub verified ${configured.cname}`);
      terminal.note(dnsInstruction(configured.cname, await providerHost(api, publication.siteId)));
      terminal.note(`After DNS propagates, run: ${cliCommand('domain check')}`);
      return configured;
    }
    const committed = await api.commitTopologyChange(publication.siteId, pending.changeId);
    terminal.done(committed.cname
      ? `${committed.cname} is live with enforced HTTPS`
      : 'The GitHub Pages address is live again');
    if (!committed.cname) {
      terminal.note('Remove the old custom-domain records from your DNS provider.');
    }
    return committed;
  }

  throw new UsageError(`Unsupported domain action: ${action}`);
}

async function ownedSite(api, siteId) {
  const sites = await api.listPublications();
  const site = Array.isArray(sites) ? sites.find((candidate) => candidate.siteId === siteId) : null;
  if (!site || typeof site.repository !== 'string' || typeof site.publicationUrl !== 'string') {
    throw new Error('Publication is not available');
  }
  return site;
}

async function providerHost(api, siteId) {
  return (await ownedSite(api, siteId)).repository.split('/')[0].toLowerCase() + '.github.io';
}

function dnsInstruction(host, target) {
  return `For a subdomain: CNAME ${host} → ${target}. For an apex domain, use GitHub’s documented A/AAAA records.`;
}

function showPending(terminal, pending) {
  terminal.result(`${pending.canonicalBaseUrl}${pending.pathPrefix}`);
  terminal.note(`State: ${pending.state}`);
  if (pending.state === 'PREPARED') terminal.note(`Next: verify ownership, then run ${cliCommand('domain check')}.`);
  else terminal.note(`Next: configure DNS, then run ${cliCommand('domain check')}.`);
}
