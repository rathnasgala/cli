# Gala CLI

Create, validate, preview, publish, and maintain a GitHub-backed Gala publication from your terminal.

The quick start below begins with the required accounts and tools and does not assume a global CLI installation.

## Requirements

- [Git](https://git-scm.com/downloads)
- [Node.js 24](https://nodejs.org/en/download) recommended; the CLI package supports Node.js 18 or newer
- A [GitHub account](https://github.com/signup)
- The [Gala GitHub App](https://github.com/apps/gala67-app/installations/new) — `scaffold` walks you through installing it if it is not already

Check your local tools:

```console
node --version
npm --version
git --version
```

You should see something like this:
```console
v22.18.0
10.9.3
git version 2.50.1 (Apple Git-155)
```

## Quick start

One command, run inside an empty folder named after the publication you want:

```console
mkdir field-notes && cd field-notes
npx --yes @rathnasgala/cli@latest scaffold --target ./
```

That single command does all of the following, and asks only for what it cannot work out:

1. **Signs you in to Gala** if no valid token is stored, showing a code to enter in the browser.
2. **Signs you in to GitHub** the same way, as the Gala GitHub App. It requests no scopes: a GitHub
   App's permissions are fixed on the app and granted when you install it, so Gala reaches only the
   repositories you have shared with it — never every repository you can access.
3. **Reads your GitHub account** from that token, so there is no username to type.
4. **Finds the Gala GitHub App installation** for your account. If the App is not installed yet it
   prints the installation page, waits while you install it, and carries on — the installation ID
   is never something you have to read out of a URL.
5. **Names the publication** after the folder you are standing in.
6. **Creates the repository** from the site template, registers it, installs its one-time secret,
   writes the publication workflow, commits, and enables GitHub Pages.

Both sign-ins are skipped when a valid credential is already stored, so re-running is cheap.

After scaffolding succeeds, open [GitHub App settings](https://github.com/settings/installations)
and restrict the App to the publication repository if you installed it against all of them.

### Write, preview, and publish

```console
npx --yes @rathnasgala/cli@latest new --title "My first post" --language en
npx --yes @rathnasgala/cli@latest preview
npx --yes @rathnasgala/cli@latest publish
```

`new` prints the Markdown file it created. Write below the second `---` line, save the file,
preview it locally, then publish it through GitHub.

### Overriding what scaffold works out

Every derived value is still an explicit flag, for the cases where the default is wrong — a
publication owned by an organisation, a folder named differently from the repository, or more than
one App installation on the account:

```console
npx --yes @rathnasgala/cli@latest scaffold \
  --owner YOUR_GITHUB_USERNAME \
  --repository YOUR_REPOSITORY_NAME \
  --target ./YOUR_REPOSITORY_NAME \
  --installation-id YOUR_INSTALLATION_ID
```

`--repository` is otherwise taken from `--target`, then from `--site-name`, and only then asked
for. Outside a terminal — in CI — nothing is ever prompted for: a value that cannot be derived is
an error, so an automated run fails fast instead of waiting for an answer that will not come.

## Command reference

Run commands through `npx` without installing a global package:

```console
npx --yes @rathnasgala/cli@latest COMMAND [options]
```

Inside the table below, `gala` is shorthand for that prefix.

| Command | Purpose | Common options |
| --- | --- | --- |
| `gala auth` | Authenticate the author with Gala | `--api-base-url URL` for a non-production API |
| `gala auth github` | Authenticate the CLI with GitHub | Browser device flow; requests `repo workflow` |
| `gala scaffold` | Sign in if needed, then create and register a publication | All derived; override with `--owner`, `--repository`, `--target`, `--installation-id` |
| `gala configure` | Update author-owned site and design settings | `--root`, plus the configuration options below |
| `gala new` | Create a Markdown post variant | `--root`, `--title`, `--language`, `--today` |
| `gala validate` | Validate repository content without publishing | optional root path, `--today` |
| `gala preview` | Validate and run the local Eleventy preview | `--root`, `--today` |
| `gala publish` | Validate, commit, and push publication changes | `--root`, `--today`, `--force` |
| `gala doctor` | Report managed-framework drift and publication-state validity | optional root path; `--fix --source TRUSTED_ROOT` |
| `gala hook install` | Install the pre-push validation hook | `--root` |
| `gala refresh` | Refresh and commit the engagement snapshot | `--root` |
| `gala upgrade` | Verify and install an exact theme-package release | `--root`, `--channel`, `--yes` |
| `gala topology` | Switch canonical origin/path topology transactionally | `--root`, `--owner`, `--repository`, `--canonical-base-url`, `--path-prefix` |
| `gala entitlement` | Retrieve and commit the current paid attribution artifact | `--root` |
| `gala workflow` | Write the reusable GitHub Actions workflow | `--root`, `--site-id`, `--timezone`, `--action-ref`, `--default-branch`, `--mode` |
| `gala record-deployment` | Record state after a successful deployment | `--root`, `--today`, `--commit-sha` |

### Scaffold and configure options

The same author-owned options are accepted by `scaffold` and `configure`:

```text
--site-name
--author
--language
--timezone
--theme
--layout
--palette
--typography
--spacing
--radius
--density
--motion
--componentStyle
--share-target       repeatable
--social-profile     repeatable
```

Use only identities supported by the installed theme package. Validation rejects unavailable layout, palette, and theme identities instead of silently substituting another design.

### Scaffold an existing empty repository

Use this only when the exact GitHub repository already exists and has no branches or content:

```console
npx --yes @rathnasgala/cli@latest scaffold \
  --repository YOUR_REPOSITORY_NAME \
  --empty-existing-repository
```

### Resume interrupted scaffolding

The target must already be a checkout whose HTTPS origin exactly matches the requested repository:

```console
npx --yes @rathnasgala/cli@latest scaffold \
  --repository YOUR_REPOSITORY_NAME \
  --target ./YOUR_REPOSITORY_NAME \
  --resume
```

Scaffolding is designed to converge after partial failure. It will not adopt a non-empty unrelated repository.

## Everyday workflow

Create another post:

```console
npx --yes @rathnasgala/cli@latest new --title "A durable idea" --language en
```

Validate without running a preview server:

```console
npx --yes @rathnasgala/cli@latest validate
```

Preview locally:

```console
npx --yes @rathnasgala/cli@latest preview
```

Publish:

```console
npx --yes @rathnasgala/cli@latest publish
```

Check managed files and recorded publication state:

```console
npx --yes @rathnasgala/cli@latest doctor
```

## Security and ownership

- Your repository remains the canonical source for publication content and configuration.
- Gala credentials and GitHub App credentials are stored outside the repository.
- Credential directories are created with private permissions; credential files use mode `0600` on operating systems that support POSIX modes.
- The site signing secret is returned once by the API and sealed directly into GitHub Actions secrets.
- Do not copy credential files into the repository, dotfiles, cloud-sync folders, or `/tmp`.
- The generated workflow pins the public Gala Action contract; managed framework files are integrity-checked before repair or upgrade.

## Troubleshooting

### `GitHub authentication is missing`

Run:

```console
npx --yes @rathnasgala/cli@latest auth github
```

### Gala authentication expired

Gala author tokens expire and do not use a refresh token. Run:

```console
npx --yes @rathnasgala/cli@latest auth
```

### `The Gala GitHub App is not installed on YOUR_ACCOUNT`

`scaffold` could not find an installation covering that account. At a terminal it prints the
installation page and waits; in CI it stops, because there is nobody to install it. Install the App
at [the installation page](https://github.com/apps/gala67-app/installations/new) and run `scaffold`
again, or pass `--installation-id` explicitly.

### The App cannot access the new repository

Open [GitHub App settings](https://github.com/settings/installations) and add the publication repository to the Gala installation. The platform verifies access to the exact repository; the existence of an installation alone is insufficient.

### The target folder already exists

Do not delete or overwrite it blindly. Use `--resume` only when it is the intended repository checkout. Use `--empty-existing-repository` only when the remote GitHub repository is genuinely empty.

### Validation refuses a post

The error includes the source file and violated rule. Correct the file and run:

```console
npx --yes @rathnasgala/cli@latest validate
```

Do not use `publish --force` as a routine bypass. It skips content validation but does not force-push Git history.

### Managed files have drifted

Inspect first:

```console
npx --yes @rathnasgala/cli@latest doctor
```

Repair requires a trusted, hash-verified theme source:

```console
npx --yes @rathnasgala/cli@latest doctor --fix --source PATH_TO_TRUSTED_THEME
```

## Package and source

- npm: [`@rathnasgala/cli`](https://www.npmjs.com/package/@rathnasgala/cli)
- source: [`rathnasgala/cli`](https://github.com/rathnasgala/cli)

## License

The repository does not currently declare a license. Copyright remains with its owner unless and until a license is added.
