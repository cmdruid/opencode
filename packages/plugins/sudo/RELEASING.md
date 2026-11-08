# Releasing @cmdcode/opencode-safe-sudo

Releases support Linux x64 and macOS arm64. Use the repository-pinned Bun, Node 26/npm, Python 3, a static Linux C toolchain, and Apple Clang on macOS. Both executables ship in one archive; users never compile them or run an installation hook. The source directory remains `packages/plugins/sudo` and the internal plugin ID remains `experimental.sudo`.

## Build and verify

From a checkout of the release commit on each native platform:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/plugins/sudo build:native
```

Build the Darwin helper on macOS 15 arm64 for the supported deployment floor. Its linker-generated ad hoc signature is verified before hashing. Test the final archive on macOS 15 and 26; a deployment target alone does not prove compatibility. The observed human authentication baseline is macOS 26.4.1. Linux must build on x64 with static linkage.

Transfer each `packages/plugins/sudo/native/bin/<platform>/` directory, including its checksum and executable modes, into the assembly checkout at the same commit. The workflow uses tar archives to preserve modes. Then, from the repository root:

```sh
bun run check
bun run --cwd packages/plugins/sudo typecheck:tsc
mkdir -p dist/plugins
```

From `packages/plugins/sudo`:

```sh
bun pm pack --destination ../../../dist/plugins
```

`prepack` verifies that both platform helpers have correct architecture, permissions, and checksums, then compiles the Solid TUI. It does not build or replace either native helper. Missing or damaged assets fail packaging. Ordinary `bun run build` builds only the host helper and TUI for development.

Transfer the single assembled archive to native Linux x64 and macOS arm64 checkouts at the same commit. On each, from `packages/plugins/sudo`:

```sh
bun run build
bun run verify:archive ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.2.0.tgz
bun script/smoke-install.ts ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.2.0.tgz
for scenario in success slow cancel review-cancel; do
  python3 test/fixture/manual.py "$scenario"
done
```

The local build prepares test fixtures. Archive verification runs the complete suite against the shipped native source and compiled TUI, verifies both packaged binaries, and executes the current platform's shipped helper. The clean-install test loads both entrypoints outside the workspace with install scripts disabled. No test exclusions are permitted for release. The broker's fake-timer test passes with pinned Bun 1.4.4; the spike's Bun 1.4.0 failure is not a release exception.

Run the isolated tmux fixture for Linux regression. Before release, human-check the final package's password authentication, macOS Touch ID, cancellation/fallback, and terminal restoration using the isolated `script/manual.ts` runner in a real terminal. Enter credentials only at system sudo, without recording or input diagnostics. Do not claim macOS tmux/SSH support until those environments are checked. Keep credentials out of automated tests; fake sudo uses only dummy input.

Dry-run publication without rebuilding the archive:

```sh
npm publish ../../../dist/plugins/cmdcode-opencode-safe-sudo-0.2.0.tgz --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

Keep and publish the exact tested archive. `.github/workflows/publish-plugins.yml` builds the two native assets separately, assembles once, and tests that archive on Linux x64 and macOS 15/26 arm64. Publishing waits for every verification job and checks the archive digest. Only the publish job receives OIDC permission; it does not check out or execute package source. The npm installation path is tested; browser-download quarantine and other distribution/signing paths are outside this release.

## First publication: account setup

An npm account authorized to publish packages in `@cmdcode` must perform the initial publication. The recommended route is an interactive login and 2FA in your own terminal:

```sh
npm login --registry=https://registry.npmjs.org/
```

npm manages the resulting credentials in your user configuration (`~/.npmrc`). Do not put credentials in this repository, chat, package files, or a project `.npmrc`. No npm token is required in GitHub Actions for subsequent releases.

Once the release commit is pushed to `custom` and the archive is verified, publish the first version from the repository root:

```sh
npm publish ./dist/plugins/cmdcode-opencode-safe-sudo-0.2.0.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/
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
3. Tag that commit with `opencode-safe-sudo-v<VERSION>` and push the tag. For example, after bumping to `0.2.1`:

```sh
git push origin custom
git tag opencode-safe-sudo-v0.2.1
git push origin opencode-safe-sudo-v0.2.1
```

Pushing the tag publishes the package if all checks pass and npm trust is configured. The workflow requires the tagged commit to belong to `origin/custom` and the tag version to match the package. Stable versions publish to `latest`; prereleases such as `0.2.0-beta.1` publish to `next`. An already published version cannot be reused; do not push a release tag for a version bootstrapped manually.

The workflow is restricted to `cmdruid/opencode` and currently allowlists only this plugin. Adding another plugin means explicitly adding its tag, package path, tests/build, and npm trusted-publisher configuration. It does not alter OpenCode's upstream release pipeline.

Pull requests targeting `custom` and pushes to `custom` affecting the sudo plugin, release workflow, or dependency manifests build, test, dry-run, and upload an archive without publishing. Pull requests verify the prospective merge on native Linux x64 and macOS arm64 before landing. Manual workflow runs do the same; select the `custom` branch. GitHub only exposes manual dispatch once the workflow also exists on the repository's default branch. Tag-triggered releases can run from the tagged `custom` commit without changing the default branch.

## Installation after release

```json
{
  "plugins": ["@cmdcode/opencode-safe-sudo"]
}
```

Support is OpenCode v2 on Linux x64 or macOS arm64, with the TUI on the same host as the server. Existing Linux SSH/tmux support remains; macOS environment validation and optional Touch ID behavior are described in README.md. Use the normal plugin manager to install or update.
