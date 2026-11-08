// The Electron main process.
//
// What this adds over the browser version: a window that is the application rather than a tab, a tray
// icon that stays while the tool is running, and a menu with the actions a desktop app is expected to
// have. The page itself is unchanged — it is the same HTML the local server already serves, loaded
// from the same origin, so there is one UI to maintain rather than two.
//
// The renderer is not given Node access. Everything it needs comes over HTTP from the loopback server,
// which already has the key and Origin rules the in-DSH panel settled on. Turning `nodeIntegration` on
// to save a fetch would put an arbitrary page one XSS away from the whole filesystem.

// --- environment repair, before anything else ---
//
// ELECTRON_RUN_AS_NODE turns this binary into plain Node with no GUI API at all. It is set by some
// hosts — DSH sets it for the processes it spawns — and every child inherits it. Launched from such a
// shell, `require('electron')` returns a string and `app` is undefined, and the app dies on the first
// line. Clearing it here is the difference between working and not working under that shell.
delete process.env.ELECTRON_RUN_AS_NODE

const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// This directory lives inside the package, so the package root is one level up.
const ROOT = join(__dirname, '..')
const ICON = join(ROOT, 'assets', 'icon-256.png')

/** @type {BrowserWindow | null} */
let window = null
/** @type {Tray | null} */
let tray = null
/** @type {{url: string, close: () => Promise<void>} | null} */
let server = null
let quitting = false

/**
 * Start the loopback server the page talks to.
 *
 * Loaded dynamically because those are ES modules while this process is CommonJS — Electron's main
 * process does not support ESM without a flag, and adding that flag changes how every other module in
 * the app resolves.
 */
async function startServer() {
  const { randomBytes } = await import('node:crypto')
  const serverUrl = pathToFileURL(join(ROOT, 'src', 'outside', 'server.js')).href
  const inspectUrl = pathToFileURL(join(ROOT, 'src', 'repair', 'inspect.js')).href
  const { startOutsideServer } = await import(serverUrl)
  const { resolveDshHome, listProfiles } = await import(inspectUrl)

  let home
  try {
    home = resolveDshHome(undefined)
  } catch (error) {
    throw new Error(`找不到 DSH 目录：${error instanceof Error ? error.message : String(error)}`)
  }

  // The profile is picked the same way the CLI picks it: whichever exists, preferring the desktop one,
  // which is what almost every user runs.
  const profiles = listProfiles(home)
  const profile = profiles.includes('desktop') ? 'desktop' : (profiles[0] ?? 'desktop')

  return startOutsideServer({ home, profile, key: randomBytes(24).toString('hex') })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1000,
    height: 880,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: '#101216',
    icon: ICON,
    title: '插件健康',
    // No menu bar on Windows: this is a utility, and a File/Edit/View strip it does not use would be
    // decoration. The menu stays reachable through the tray.
    autoHideMenuBar: true,
    webPreferences: {
      // The page is served over HTTP by the local server, so it needs no Node privileges.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => { window?.show() })

  // A link to an external site opens in the real browser, not in the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' }
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  // Closing the window hides it rather than quitting: the tool is worth having reachable from the tray
  // for exactly the moment the window was closed — when DSH will not start.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window?.hide()
    if (tray !== null && !tray.isDestroyed()) {
      try {
        tray.displayBalloon({
          title: '插件健康仍在后台',
          content: '从任务栏图标可以重新打开。退出请用托盘菜单。',
          icon: nativeImage.createFromPath(ICON),
        })
      } catch { /* balloon notifications are optional */ }
    }
  })

  window.on('closed', () => { window = null })
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '插件健康',
      submenu: [
        { label: '打开窗口', click: () => { window?.show(); window?.focus() } },
        { label: '重新加载', click: () => { window?.webContents.reload() } },
        { type: 'separator' },
        {
          label: '在浏览器中打开',
          click: () => { if (server !== null) shell.openExternal(server.url).catch(() => {}) },
        },
        { type: 'separator' },
        { label: '退出', click: () => { quitting = true; app.quit() } },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '插件健康',
              message: '插件健康 · 局外工具',
              detail: [
                '在 DSH 启动之前检查它能不能起来，保存和恢复配置，并在 DSH 起不来时抢救。',
                '',
                '诊断正在运行的 DSH 请用 DSH 里的面板 —— 那需要宿主。',
              ].join('\n'),
              icon: nativeImage.createFromPath(ICON),
            }).catch(() => {})
          },
        },
      ],
    },
  ])
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(ICON)
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }))
    tray.setToolTip('插件健康')
    tray.setContextMenu(buildMenu())
    tray.on('click', () => { window?.show(); window?.focus() })
  } catch {
    // A tray is a convenience; without one the window still works.
    tray = null
  }
}

// A second launch focuses the existing window instead of starting a second server on a second port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { window?.show(); window?.focus() })

  app.whenReady().then(async () => {
    try {
      server = await startServer()
      createWindow()
      createTray()
      Menu.setApplicationMenu(buildMenu())
      await window?.loadURL(server.url)
    } catch (error) {
      dialog.showErrorBox('无法启动', error instanceof Error ? error.message : String(error))
      app.quit()
    }
  })

  // Deliberately not quitting when the window closes: the tray keeps the tool available, and on macOS
  // this is the platform convention anyway.
  app.on('window-all-closed', () => {})

  app.on('before-quit', async () => {
    quitting = true
    try { await server?.close() } catch { /* already gone */ }
  })

  app.on('activate', () => {
    if (window === null) {
      createWindow()
      if (server !== null) window.loadURL(server.url)
    } else {
      window.show()
    }
  })
}
