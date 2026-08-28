import './index.css'

const app = document.querySelector<HTMLDivElement>('#app')

async function render(): Promise<void> {
  if (!app) return

  try {
    const info = await window.port.appInfo()
    app.innerHTML = `
      <h1>Port</h1>
      <p class="versions">Electron ${info.electron} · Chromium ${info.chromium} · Node ${info.node}</p>
      <p class="app-version">port ${info.app}</p>
    `
  } catch (error) {
    console.error('Failed to load app info', error)
    app.innerHTML = '<p class="error">Could not reach the main process.</p>'
  }
}

void render()
