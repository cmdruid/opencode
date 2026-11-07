# Releasing @cmdcode/opencode-safe-sudo

The first version is `0.1.0`. Releases are built on Linux x64 with the repository-pinned Bun, Node 26/npm, Python 3, and a static C toolchain. The native executable is built into the archive; users never compile it or run an installation hook. The source directory remains `packages/plugins/sudo` and the internal plugin ID remains `experimental.sudo`.

## Build and verify locally

From the repository root on `custom`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run --cwd packages/plugins/sudo typecheck:tsc
mkdir -p dist/plugins
```

From `packages/plugins/sudo`:

```sh
bun pm pack --destination ../../../dist/plugins
bun run verify:archive ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.1.0.tgz
bun script/smoke-install.ts ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.1.0.tgz
npm publish ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.1.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

`prepack` builds the native helper and compiles the Solid TUI to JavaScript. This makes installed packages independent of workspace JSX configuration. `verify:archive` runs the package suite against that exact archive, compiles its native source with fake sudo, and loads its compiled TUI in the PTY tests. Update the filename for later versions. Keep the archive produced by this process; publish that archive, not an extracted directory whose maintainer build scripts are intentionally excluded.

Before activation, verify automatic return with fake sudo and run the isolated tmux fixture. Build the helper, checksum, and compiled TUI together; replace the complete artifact only while no sudo handoff is active. The tool now requires `reason`, for example `{ "command": "systemctl reload example", "reason": "Reload the system service to apply the requested configuration." }`.

Artifact checks verify the shipped static binary and entrypoints. Behavioral tests compile the same native source with an unprivileged fake sudo; they never exercise real credentials or privileged commands.

## First publication: account setup

An npm account authorized to publish packages in `@cmdcode` must perform the initial publication. The recommended route is an interactive login and 2FA in your own terminal:

```sh
npm login --registry=https://registry.npmjs.org/
```

npm manages the resulting credentials in your user configuration (`~/.npmrc`). Do not put credentials in this repository, chat, package files, or a project `.npmrc`. No npm token is required in GitHub Actions for subsequent releases.

Once the release commit is pushed to `custom` and the archive is verified, publish the first version from the repository root:

```sh
npm publish ./dist/plugins/cmdcode-opencode-safe-sudo-0.1.0.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

This command is the actual public release. Until it succeeds, installation by package name is unavailable. The interactive bootstrap does not have GitHub Actions provenance. Later automated releases do.

If you need an API token instead, use a narrowly scoped, short-lived granular npm token through your own user-level npm configuration, never a committed file. The interactive login route avoids creating a separate automation credential. See [npm's publication requirements](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

## Configure trusted publishing for future releases

On npm, open `@cmdcode/opencode-safe-sudo` → Settings → Trusted publishing → GitHub Actions. Configure:

| Field                | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| Organization or user | `cmdruid`                                               |
| Repository           | `opencode`                                              |
| Workflow filename    | `publish-plugins.yml`                                   |
| Environment name     | Leave blank (this workflow does not use an environment) |
| Allowed actions      | Allow direct `npm publish`                              |

The file is `.github/workflows/publish-plugins.yml`. The npm organization (`cmdcode`) and GitHub owner (`cmdruid`) intentionally differ. Configure this on each future plugin package that uses the workflow.

Use GitHub-hosted runners. The workflow uses Node 26 with an npm version supporting OIDC (npm 11.5.1 or newer). Only the publish job gets `id-token: write`; it downloads and verifies the tested archive without checking out or executing package source. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed. Public-repository releases receive npm provenance automatically.

npm currently expires a new trusted-publisher configuration if its first successful publish does not happen within two days. Set it up when the next version is ready, or recreate an expired configuration. After verifying trusted publishing, npm recommends requiring 2FA and disallowing traditional publishing tokens. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

1. Update the plugin's version in `packages/plugins/sudo/package.json`, run `bun install --lockfile-only --ignore-scripts`, and update release notes as appropriate. Plugin versions are independent of OpenCode's version.
2. Commit the release changes on `custom` and push that branch.
3. Tag that commit with `opencode-safe-sudo-v<VERSION>` and push the tag. For example, after bumping to `0.1.1`:

```sh
git push origin custom
git tag opencode-safe-sudo-v0.1.1
git push origin opencode-safe-sudo-v0.1.1
```

Pushing the tag publishes the package if all checks pass and npm trust is configured. The workflow requires the tagged commit to belong to `origin/custom` and the tag version to match the package. Stable versions publish to `latest`; prereleases such as `0.2.0-beta.1` publish to `next`. An already published version cannot be reused; do not push a release tag for a version bootstrapped manually.

The workflow is restricted to `cmdruid/opencode` and currently allowlists only this plugin. Adding another plugin means explicitly adding its tag, package path, tests/build, and npm trusted-publisher configuration. It does not alter OpenCode's upstream release pipeline.

Pushes to `custom` affecting the sudo plugin, release workflow, or dependency manifests build, test, dry-run, and upload an archive without publishing. Manual workflow runs do the same; select the `custom` branch. GitHub only exposes manual dispatch once the workflow also exists on the repository's default branch. Tag-triggered releases can run from the tagged `custom` commit without changing the default branch.

## Installation after release

```json
{
  "plugins": ["@cmdcode/opencode-safe-sudo"]
}
```

Support remains OpenCode v2 on Linux x64, TUI on the same host as the server (including SSH/tmux). Use the normal plugin manager to install or update.
