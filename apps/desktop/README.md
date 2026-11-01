# port desktop app

An Electron + TypeScript cockpit for the port pipeline — see the root [README.md](../../README.md) → "Desktop app" for the posture.

## Requirements

- `claude` (Claude Code) installed.
- `gh` installed and signed in (`gh auth login`).

## Install

Download the installer for your OS from the assets of the [latest release](https://github.com/b-at-neu/port/releases/latest) — `-arm64.dmg` (Apple Silicon Mac) or `-x64.dmg` (Intel Mac), `.exe` (Windows), `.AppImage` or `.deb` (Linux). Every installer is unsigned, so the OS warns on first launch:

- **macOS**: System Settings → Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/port.app`.
- **Windows**: SmartScreen → **More info** → **Run anyway**.
- **Linux**: `chmod +x` the AppImage. It needs `libfuse2`; on Ubuntu 24.04+, where AppArmor can block an unprivileged AppImage sandbox, prefer the `.deb` instead (see "Risks" in the ticket that added this, #335).

Unreleased builds from `dev` are on the **Package desktop app** workflow's runs, as the `port-desktop-<OS>-v<version>` artifact, kept for 7 days.

## Building installers

```bash
pnpm dist   # from the repository root, or inside apps/desktop
```

This renders `build/icon.png` from `docs/design/port-app-icon.svg`, builds the app, packages it with electron-builder, and audits every resulting `app.asar` for a bundled Claude binary — the app always runs your own installed `claude`, never one of the Agent SDK's per-platform binaries. Output lands in `apps/desktop/dist/`.

## Versioning

The plugin and the desktop app ship at one version: `.claude/port.config.json` → `release.versionFiles` lists both manifests, and `/port:release` and the dev window bump them together. The `version-files-agree` check fails if they ever disagree.

A dev build also shows the git commit next to its version, e.g. `<X.Y.Z>-dev · <sha>` (`<sha>+dirty` for an uncommitted tree) — baked in at build time, so it only updates on the next `pnpm dev` restart. A clean release shows just the version.

## Data locations

A packaged build's userData directory is named `port`; a `pnpm dev` run's is named `@port/desktop` (Electron's own default, from `package.json`'s `name` field there). The two never share a registry, settings, or session state.

## Development

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) → "Working on the desktop app".
