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

## Terminal cockpit

Running `/port:pipeline` in a repository this app manages is unsupported. The app reads a `.agents/cockpit.json` that names the terminal as owner as unreadable, and won't run that repository until the file is deleted.

Hosted sessions load only the plugins installed in Claude Code, never a repository's own `plugins/port/`.

## Updates

**When it checks:** on every launch of an installed build, with no timer and no throttle. port compares its version with the latest stable GitHub release, skipping drafts and prereleases. `pnpm dev` and other unpackaged runs, and any `-dev` version, never check and never touch the network. An offline or rate-limited startup check fails silently, with no notice and no dialog; Settings → About shows the reason.

**What you see:** an update notice in the sidebar (an icon when the sidebar is collapsed), only when a newer release exists. Settings → About shows the update status at any time.

**Checking by hand:** **Check for updates** is in the **port** menu on macOS, after About, and in the **Help** menu on Windows and Linux. It reports up to date, available (with **Update**) or an error, in a toast. In a dev build it says update checks only run in installed builds.

**What Update does:**

| Platform | What one click does |
| --- | --- |
| Windows (`.exe`) | Downloads the update in place, then restarts port to install it. |
| Linux AppImage (launched as an AppImage, so `APPIMAGE` is set) | Downloads the update in place, replaces the AppImage, then restarts. |
| macOS (`.dmg`) | Downloads the right dmg for your Mac (Apple silicon or Intel) to Downloads, then opens it. Drag port into Applications. |
| Linux `.deb` | Downloads the `.deb` to Downloads, then opens it in your software installer. Install it, then restart port. |

**Restart and live sessions:** before an in-place restart, port asks first if stage sessions are running (the usual quit dialog). Declining leaves **Restart now** on the notice. If the in-place update fails, port falls back to downloading the installer: Windows opens it, and AppImage shows the new file in its folder.

**Why macOS doesn't update in place:** port's macOS builds are ad-hoc signed and not notarized, and there is no Apple Developer ID. macOS's updater (Squirrel.Mac, which `electron-updater` uses) only installs an update signed with the same Developer ID as the running app, so an ad-hoc build can't replace itself. In-place updates on macOS would need all of: a Developer ID certificate, notarization, a `zip` target next to the `dmg` (the macOS updater installs from a zip), and enabling in-place for `dmg` in `inPlaceSupported`.

**Why `.deb` doesn't:** the package manager owns a `.deb` install, and replacing its files needs root, so port hands the file to your installer instead. Windows needs no signature for in-place updates, so the unsigned installer updates itself. SmartScreen may still warn the first time.

## Building installers

```bash
pnpm dist   # from the repository root, or inside apps/desktop
```

This renders `build/icon.png` from `docs/design/port-app-icon.svg`, builds the app, packages it with electron-builder, and audits every resulting `app.asar` for a bundled Claude binary — the app always runs your own installed `claude`, never one of the Agent SDK's per-platform binaries. Output lands in `apps/desktop/dist/`. With the `publish` block, `dist` also writes the update metadata next to the installers: `latest.yml` plus `.exe.blockmap` on Windows, `latest-mac.yml` plus `.dmg.blockmap`s on macOS, and `latest-linux.yml` on Linux (the AppImage embeds its blockmap). It also bakes `app-update.yml` into the app. `dist` still publishes nothing (`--publish never`): `desktop-release.yml` attaches the installers and these files to the release, and the audit fails if any of them is missing.

## Versioning

The plugin and the desktop app ship at one version: `.claude/port.config.json` → `release.versionFiles` lists both manifests, and `/port:release` and the dev window bump them together. The `version-files-agree` check fails if they ever disagree.

A dev build also shows the git commit next to its version, e.g. `<X.Y.Z>-dev · <sha>` (`<sha>+dirty` for an uncommitted tree) — baked in at build time, so it only updates on the next `pnpm dev` restart. A clean release shows just the version.

## Data locations

A packaged build's userData directory is named `port`; a `pnpm dev` run's is named `@port/desktop` (Electron's own default, from `package.json`'s `name` field there). The two never share a registry, settings, or session state.

## Development

See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) → "Working on the desktop app".
