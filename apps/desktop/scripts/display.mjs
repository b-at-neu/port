const INSTALL_XVFB = 'sudo apt install xvfb (Debian/Ubuntu) · sudo dnf install xorg-x11-server-Xvfb (Fedora) · sudo pacman -S xorg-server-xvfb (Arch)'

export function displayPlan({ platform, hasXvfb, hasDisplay }) {
  if (platform === 'linux') {
    if (hasXvfb) return { kind: 'xvfb' }
    if (!hasDisplay) {
      return {
        kind: 'refuse',
        lines: [
          '[screenshots] No display and no xvfb-run, so there is nowhere to open the app window.',
          `  Install Xvfb: ${INSTALL_XVFB}, or run with a display.`,
        ],
      }
    }
    return {
      kind: 'desktop',
      lines: [
        '[screenshots] xvfb-run not found — the app window will open on your desktop for this run.',
        '  It opens without taking focus, but stays visible until the run finishes.',
        `  Install Xvfb to keep runs off your desktop: ${INSTALL_XVFB}.`,
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      kind: 'desktop',
      lines: [
        '[screenshots] macOS has no virtual display — the app window opens in the background for this run.',
        '  It takes no focus and shows no Dock icon; it closes when the run finishes.',
      ],
    }
  }
  return {
    kind: 'desktop',
    lines: [
      '[screenshots] Windows has no virtual display — the app window opens in the background for this run.',
      '  It takes no focus; it closes when the run finishes.',
    ],
  }
}
