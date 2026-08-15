# Gala CLI

Create, validate, preview, publish, and maintain a GitHub-backed Gala publication from your terminal.

The quick start below begins with the required accounts and tools and does not assume a global CLI installation.

## Requirements

- [Git](https://git-scm.com/downloads)
- [Node.js 24](https://nodejs.org/en/download) recommended; the CLI package supports Node.js 18 or newer
- A [GitHub account](https://github.com/signup)
- The [Gala GitHub App](https://github.com/apps/gala67-app/installations/new) installed for the account that will own the publication

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

### 1. Authenticate with Gala

```console
npx --yes @rathnasgala/cli@latest auth
```

The CLI displays a short code and opens the platform authorization page. The resulting Gala token is stored in your operating system's application-config directory, never in the publication repository.

### 2. Authenticate with GitHub

```console
npx --yes @rathnasgala/cli@latest auth github
```

GitHub OAuth Apps cannot restrict `repo` access to one repository. The CLI therefore requests:

- `repo` to create the publication repository and install its Actions secret
- `workflow` for initial scaffolding and explicit Action-major migrations

The GitHub token is stored outside the repository with private file permissions. Gala does not require `workflow` for ordinary publishing or patch upgrades.

### 3. Install the GitHub App

Open the [Gala GitHub App installation page](https://github.com/apps/gala67-app/installations/new). For a new publication, select **All repositories** temporarily because the target repository does not exist yet.

After installation, GitHub redirects to a URL ending in a number, for example:

```text
https://github.com/settings/installations/153144989
```

That final number is the installation ID required by `scaffold`.

### 4. Scaffold the publication

Replace every capitalized placeholder:

```console
npx --yes @rathnasgala/cli@latest scaffold \
  --owner YOUR_GITHUB_USERNAME \
  --repository YOUR_REPOSITORY_NAME \
  --target ./YOUR_REPOSITORY_NAME \
  --installation-id YOUR_INSTALLATION_ID \
  --mode build-and-deploy
```

Scaffolding creates a public repository from `rathnasgala/site-template`, registers the site, installs the one-time site secret as a GitHub Actions secret, writes the publication workflow, commits the generated configuration, and enables GitHub Pages.

After scaffolding succeeds, open [GitHub App settings](https://github.com/settings/installations) and restrict the App to the publication repository.

### 5. Write, preview, and publish

```console
cd YOUR_REPOSITORY_NAME
npx --yes @rathnasgala/cli@latest new --title "My first post" --language en
npx --yes @rathnasgala/cli@latest preview
npx --yes @rathnasgala/cli@latest publish
```

`new` prints the Markdown file it created. Write below the second `---` line, save the file, preview it locally, then publish it through GitHub.

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
| `gala scaffold` | Create and register a publication | `--owner`, `--repository`, `--target`, `--installation-id`, `--mode` |
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
  --owner YOUR_GITHUB_USERNAME \
  --repository YOUR_REPOSITORY_NAME \
  --target ./YOUR_REPOSITORY_NAME \
  --installation-id YOUR_INSTALLATION_ID \
  --empty-existing-repository
```

### Resume interrupted scaffolding

The target must already be a checkout whose HTTPS origin exactly matches the requested repository:

```console
npx --yes @rathnasgala/cli@latest scaffold \
  --owner YOUR_GITHUB_USERNAME \
  --repository YOUR_REPOSITORY_NAME \
  --target ./YOUR_REPOSITORY_NAME \
  --installation-id YOUR_INSTALLATION_ID \
  --resume
```

Scaffolding is designed to converge after partial failure. It will not adopt a non-empty unrelated repository.

### Build without deploying

```console
npx --yes @rathnasgala/cli@latest scaffold ... --mode build-only
```

`build-only` writes and validates the site but does not provision GitHub Pages. `build-and-deploy` is the default.

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
- Gala credentials and GitHub OAuth credentials are stored outside the repository.
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

### `githubInstallationId must be a positive integer`

Open [GitHub App settings](https://github.com/settings/installations), select Gala, and copy the number at the end of the browser URL.

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
