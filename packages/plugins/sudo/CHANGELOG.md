# Changelog

## 0.2.0

- Add macOS arm64 native sudo support, including system-configured Touch ID and password fallback.
- Let macOS sudo manage password echo so Touch ID can receive focus automatically.
- Preserve the macOS helper across package updates using a private verified executable copy.
- Bundle Linux x64 and macOS arm64 helpers in one archive, verified on both platforms before publication.
- Retain the existing experimental plugin identity, tool API, and credential-isolation boundary.

## 0.1.0

Initial release for OpenCode v2 on Linux x64.

- Dedicated sudo tool with a required reason and explicit command approval.
- Shell highlighting, visible control characters, expandable inspection, and keyboard scrolling.
- Native sudo authentication with credentials and authentication output kept outside OpenCode.
- Fresh conversation background and automatic return after verified terminal cleanup.
- Approval and authentication wait for the user; the command timeout starts after authentication.
- Bundled static native helper with checksum verification and no installation hooks.
