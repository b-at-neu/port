# port desktop app

An Electron + TypeScript cockpit for the port pipeline — see the root [README.md](../../README.md) → "Desktop app" for the posture.

## Requirements

- `claude` (Claude Code) installed.
- `gh` installed and signed in (`gh auth login`).

## Install

Grab the installer for your OS from the **Package desktop app** workflow's artifacts (there is no release yet — see "Building installers" below). Every installer is unsigned, so the OS warns on first launch:

- **macOS**: System Settings → Privacy & Security → **Open Anyway**, or `xattr -dr com.apple.quarantine /Applications/port.app`.
- **Windows**: SmartScreen → **More info** → **Run anyway**.
- **Linux**: `chmod +x` the AppImage. It needs `libfuse2`; on Ubuntu 24.04+, where AppArmor can block an unprivileged AppImage sandbox, prefer the `.deb` instead (see "Risks" in the ticket that added this, #335).

## Building installers

```bash
pnpm dist   # from the repository root, or inside apps/desktop
```

This renders `build/icon.png` from `docs/design/port-app-icon.svg`, builds the app, packages it with electron-builder, and audits every resulting `app.asar` for a bundled Claude binary — the app always runs your own installed `claude`, never one of the Agent SDK's per-platform binaries. Output lands in `apps/desktop/dist/`.

## Versioning

The installer version is read from `.claude/port.config.json` → `release.versionFiles[0]` (currently `plugins/port/.claude-plugin/plugin.json`), never `apps/desktop/package.json`'s own placeholder.

## Data locations

A packaged build's userData directory is named `port`; a `pnpm dev` run's is named `@port/desktop` (Electron's own default, from `package.json`'s `name` field there). The two never share a registry, settings, or session state.

## Development

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) → "Working on the desktop app".
