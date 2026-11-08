/**
 * Install the shortcuts that make the outside tool a desktop application.
 *
 * What this does, on each platform:
 *   - Windows: a .lnk on the Desktop and in the Start Menu, plus a .cmd shim that runs the tool with
 *     the right profile and leaves a window open so a crash is readable.
 *   - macOS: a .command file on the Desktop.
 *   - Linux: a .desktop entry.
 *
 * What it deliberately does not do: register a service, add an autostart entry, or install anything
 * outside the user's own profile. A tool that quietly persists is a tool people stop trusting.
 * @module outside/install
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Join with forward slashes, regardless of the host.
 *
 * A shortcut is written for another platform as often as for this one — a mac .command built on a
 * Windows checkout must still say /opt/... and not \\opt\\...
 * @param {...string} parts
 * @returns {string}
 */
function posixJoin(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== '')
    .map((part) => String(part).replace(/\\/gu, '/'))
    .join('/')
    .replace(/\/{2,}/gu, '/')
}

/** Where the tool's own assets live. */
function assetsDir(root) {
  return join(root, 'assets')
}

/** Where node itself is, so a shortcut does not depend on PATH being set the same way twice. */
function nodePath() {
  return process.execPath
}

/**
 * The command a shortcut runs.
 *
 * A .cmd rather than pointing the shortcut straight at node: when the tool fails to start, the window
 * has to stay open long enough to read why. A shortcut that flashes and closes teaches the user
 * nothing.
 *
 * @param {{root: string, profile?: string, home?: string}} options
 * @returns {string}
 */
export function windowsShim({ root, profile, home }) {
  // Flags stay bare; only a path or a value that could contain a space is quoted.
  const parts = [`"${root}\\bin\\health-outside.js"`]
  if (profile !== undefined) parts.push('--profile', profile.includes(' ') ? `"${profile}"` : profile)
  if (home !== undefined) parts.push('--home', `"${home}"`)
  const quoted = parts.join(' ')
  return `@echo off
setlocal
title Plugin health - outside tool
"${nodePath()}" ${quoted}
if errorlevel 1 (
  echo.
  echo The tool exited with an error. Press any key to close.
  pause >nul
)
`
}

/**
 * A .desktop entry for Linux.
 * @param {{root: string, profile?: string, home?: string, icon: string}} options
 */
export function linuxDesktopEntry({ root, profile, home, icon }) {
  const parts = [`"${posixJoin(root, 'bin', 'health-outside.js')}"`]
  if (profile !== undefined) parts.push('--profile', profile)
  if (home !== undefined) parts.push('--home', `"${home}"`)
  return `[Desktop Entry]
Type=Application
Name=Plugin health
Comment=Check a DSH profile before it starts, snapshot it, and recover it
Exec="${nodePath()}" ${parts.join(' ')}
Icon=${icon}
Terminal=true
Categories=Development;Utility;
`
}

/**
 * A .command script for macOS.
 * @param {{root: string, profile?: string, home?: string}} options
 */
export function macCommand({ root, profile, home }) {
  const parts = [`"${posixJoin(root, 'bin', 'health-outside.js')}"`]
  if (profile !== undefined) parts.push('--profile', profile)
  if (home !== undefined) parts.push('--home', `"${home}"`)
  return `#!/bin/sh
cd "$(dirname "$0")"
"${nodePath()}" ${parts.join(' ')}
if [ $? -ne 0 ]; then
  echo
  echo The tool exited with an error. Press Return to close.
  read _
fi
`
}

/**
 * Write the shortcuts for this platform.
 *
 * @param {{root: string, home?: string, profile?: string, desktop?: string}} options
 * @returns {{ok: true, written: string[]} | {ok: false, error: string}}
 */
export function installShortcuts({ root, home, profile, desktop }) {
  const desktopDir = desktop ?? join(homedir(), 'Desktop')
  if (!existsSync(desktopDir)) return { ok: false, error: `no Desktop directory at ${desktopDir}` }

  const written = []

  if (process.platform === 'win32') {
    const shim = join(root, 'assets', 'health-outside.cmd')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(shim, windowsShim({ root, profile, home }).replace(/\n/gu, '\r\n'), 'utf8')
    written.push(shim)

    // A .lnk needs a COM object; a .cmd on the Desktop is one click away and does not. The .lnk is
    // created by a separate step that has PowerShell available, so this function stays plain Node.
    const copy = join(desktopDir, '插件健康.cmd')
    copyFileSync(shim, copy)
    written.push(copy)
    return { ok: true, written }
  }

  if (process.platform === 'darwin') {
    const command = join(desktopDir, '插件健康.command')
    writeFileSync(command, macCommand({ root, profile, home }), { mode: 0o755 })
    written.push(command)
    return { ok: true, written }
  }

  const entryDir = join(homedir(), '.local', 'share', 'applications')
  mkdirSync(entryDir, { recursive: true })
  const entry = join(entryDir, 'dsh-plugin-health.desktop')
  writeFileSync(entry, linuxDesktopEntry({ root, profile, home, icon: join(assetsDir(root), 'icon-256.png') }), { mode: 0o755 })
  written.push(entry)

  const copy = join(desktopDir, 'dsh-plugin-health.desktop')
  copyFileSync(entry, copy)
  written.push(copy)
  return { ok: true, written }
}

/** The icon files, or an empty list when they were never generated. */
export function availableIcons(root) {
  const dir = assetsDir(root)
  if (!existsSync(dir)) return []
  const wanted = ['icon.ico', 'icon-256.png', 'icon.svg']
  return wanted.filter((name) => existsSync(join(dir, name))).map((name) => join(dir, name))
}

/**
 * Read a file for a test; kept here so the module has no stray imports.
 * @param {string} path
 */
export function readText(path) {
  return readFileSync(path, 'utf8')
}
