# Gala CLI

Create a publication, write posts, preview them, and publish — from your terminal.

## Requirements

- [Git](https://git-scm.com/downloads)
- [Node.js 20](https://nodejs.org/en/download) or newer
- A [GitHub account](https://github.com/signup)

Nothing to install. Every command runs through `npx`.

## Start a publication

Create it in the current empty folder:

```console
mkdir field-notes && cd field-notes
npx --yes @rathnasgala/cli@latest init
```

Or name a new destination directly:

```console
npx --yes @rathnasgala/cli@latest init field-notes
```

The destination must be empty. An initialized Git repository with no commits and no files is also
accepted and its `.git` directory is preserved. To reserve a custom domain during setup, add
`--domain blog.example.com`; Gala still requires GitHub ownership verification and healthy DNS
before activating it.

It signs you in to Gala and to GitHub if you are not already, creates the repository, registers the
publication, and leaves a working checkout in the folder. When it finishes it prints the address
your publication will live at.

On the first run, it opens GitHub's Gala App installation page. Choose the account Gala may use,
finish the installation, and return to the terminal; the same command resumes automatically.

If the Gala GitHub App has not been given access to the new repository, it says so and links to the
one page that grants it — GitHub has no way for an app to grant itself access, so that click is
unavoidable. Everything else is automatic.

## Write

```console
npx --yes @rathnasgala/cli@latest new "The places we return to"
```

This creates the Markdown file and tells you the address the post will appear at. Write below the
second `---` line.

```console
npx --yes @rathnasgala/cli@latest preview
```

Builds the publication and serves it locally, using the exact framework version the repository is
pinned to — so what you see is what gets published. The first run installs that tooling, which takes
a moment. Stop it with Ctrl-C.

```console
npx --yes @rathnasgala/cli@latest publish
```

Checks your content, records it, and sends it to GitHub. GitHub builds and deploys from there; the
site updates a minute or two later.

## Prism configurations

Prism keeps one canonical work while letting you explicitly approve alternate reading depths and
intents. The CLI uses Gala's public lifecycle API; it never writes approval artifacts itself.

```console
npx --yes @rathnasgala/cli@latest prism status
npx --yes @rathnasgala/cli@latest prism create my-post --language en --depth brief --intent orientation
npx --yes @rathnasgala/cli@latest prism list my-post --language en
```

Use `prism edit`, `submit`, `approve`, `reject`, and `revoke` to advance a configuration. Approval,
rejection, revocation, and reducing the publication mode require terminal confirmation or `--yes`.
Configuration links default to `nofollow`; change the publication or one work with
`prism link-policy` when ordinary followed links are intentional. Commands that change repository
artifacts stay attached through Gala's materialization and GitHub Pages publication states, then
print the live publication address or a concrete terminal failure. Proposal generation likewise
waits until its revision is ready for review or generation fails.

## Custom domain

Reserve a domain after setup, then advance the verified GitHub Pages flow as DNS propagates:

```console
npx --yes @rathnasgala/cli@latest domain set blog.example.com
npx --yes @rathnasgala/cli@latest domain check
```

`domain status` resumes an interrupted change, `domain cancel` abandons it, and `domain remove`
returns the publication to its GitHub Pages address. After removal, delete the old DNS records.

## When something is wrong

```console
npx --yes @rathnasgala/cli@latest doctor
```

Inspect a verified managed-theme release without changing anything unless you confirm it:

```console
npx --yes @rathnasgala/cli@latest upgrade
```

Reports on your sign-ins, the publication folder, the publishing workflow, and anything you have
written but not sent. Each check either passes, names what is wrong and how to fix it, or says it
could not be determined — never one of those disguised as another.

## Commands

Run any command with `--help`.

| Command | What it does | Options |
| --- | --- | --- |
| `init` | Create a publication in the current or named empty directory | `--name`, `--domain` |
| `domain` | Inspect or change the custom domain | `--root` |
| `new` | Start a post | `--language`, `--root`, `--today` |
| `preview` | Build and serve the publication locally | `--root`, `--today` |
| `publish` | Check, record and send your work to GitHub | `--root`, `--today`, `--skip-checks` |
| `prism` | Manage author-approved reading configurations | `--root`, `--language`, `--depth`, `--intent`, `--modality`, `--file`, `--reason`, `--yes` |
| `upgrade` | Inspect and apply a verified managed-theme update | `--root`, `--channel`, `--yes` |
| `doctor` | Check a publication and say what is wrong | `--root` |
| `auth` | Sign in to Gala and GitHub | — |

`auth` is never a prerequisite you have to remember: any command that needs a credential obtains
one. It exists for when you want to do it deliberately — a new machine, or a different account.

Every command prompts for what it needs when run in a terminal, and every prompt has an option that
supplies it instead. With no terminal attached — in CI — nothing is ever prompted for: a value that
cannot be worked out is an error naming the option, so an automated run fails immediately rather
than waiting for an answer that will not come.

## Access

The CLI signs in as the **Gala GitHub App**. It reaches only the repositories you have given that
App, and never asks for the broad `repo` scope, which would have meant read and write access to
every repository you can see.

Credentials are stored outside the publication, in your operating system's application-config
directory, with private file permissions. Your GitHub sign-in expires after eight hours and the CLI
asks you to sign in again rather than quietly using a credential the server will refuse.

Git operations use that same sign-in, not whatever credential your machine happens to have
configured — so publishing works on a machine where those differ, or where none is configured.

## Troubleshooting

### `GitHub authentication expired`

Sign in again:

```console
npx --yes @rathnasgala/cli@latest auth
```

### Gala cannot reach the repository

The Gala GitHub App is installed but has not been given this repository. The command prints a link
to the installation that needs it; add the one repository and continue. Nothing else needs granting.

### A post is not appearing

Run `doctor`. The most common cause is work written but never sent, which it reports along with the
command to fix it.

### Something failed and the message was not enough

```console
GALA_DEBUG=1 npx --yes @rathnasgala/cli@latest publish
```

Prints the full stack. Without it, failures are one line you can act on.

## Package and source

Published as [`@rathnasgala/cli`](https://www.npmjs.com/package/@rathnasgala/cli). Source at
[rathnasgala/cli](https://github.com/rathnasgala/cli).
