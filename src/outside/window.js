/**
 * Open the tool in its own window rather than a browser tab.
 *
 * `--app=<url>` gives a borderless window with no address bar, no tabs, and its own taskbar entry —
 * which is what a small utility should look like. Chrome and Edge both support it; if neither is
 * present, falling back to the default browser is better than refusing to start.
 *
 * A real Electron shell would be smaller to look at and much larger to build, sign and update. This
 * gets the window without the packaging.
 * @module outside/window
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Browsers that can host an app-mode window, most preferred first. */
function chromiumCandidates() {
  if (process.platform === 'win32') {
    const env = process.env
    return [
      join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter((path) => path !== '')
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
}

/**
 * Find a browser that can open an app-mode window.
 * @returns {string|undefined}
 */
export function findAppWindowBrowser() {
  for (const path of chromiumCandidates()) {
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Open the URL in its own window.
 *
 * @param {string} url
 * @param {{width?: number, height?: number, profileDir?: string}} [options]
 * @returns {{ok: true, kind: 'app'|'browser', browser?: string} | {ok: false, error: string}}
 */
export function openWindow(url, { width = 980, height = 900, profileDir } = {}) {
  const browser = findAppWindowBrowser()

  if (browser !== undefined) {
    const args = [
      `--app=${url}`,
      `--window-size=${width},${height}`,
      // A separate profile keeps the tool's window out of the user's browsing session, so closing it
      // does not disturb their tabs and its storage does not mix with theirs.
      `--user-data-dir=${profileDir ?? join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'dsh-plugin-health-window')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
    ]
    try {
      const child = spawn(browser, args, { detached: true, stdio: 'ignore' })
      child.unref()
      return { ok: true, kind: 'app', browser }
    } catch (error) {
      // Fall through to the default browser rather than failing to show anything.
      void error
    }
  }

  return openDefault(url)
}

/**
 * Open in whatever the system considers the default browser.
 * @param {string} url
 */
export function openDefault(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, kind: 'browser' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
