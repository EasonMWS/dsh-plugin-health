#!/usr/bin/env node
/**
 * Start the outside tool.
 *
 * This runs when DSH is not. It opens a local page and serves the three things that need the host to
 * be absent: a pre-start admission check, snapshots, and recovery. Everything else belongs in the
 * panel inside DSH.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveDshHome, listProfiles } from '../src/repair/inspect.js'
import { startOutsideServer } from '../src/outside/server.js'

/** Read a flag value: `--profile desktop` or `--profile=desktop`. */
function flagValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === `--${name}`) return argv[i + 1]
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`插件健康 · 局外工具

用法:
  health-outside [--profile <名字>] [--home <目录>] [--no-open]

选项:
  --profile   要检查的 profile，默认取最近改过的那个
  --home      DSH home 目录，默认 ~/.dsh
  --no-open   不自动打开浏览器

它会启动一个只监听 127.0.0.1 的本地页面，提供：
  · 启动前检查：这个 profile 能不能安全启动
  · 快照：存下当前配置，出问题能退回
  · 恢复：把配置退回某个快照，先预览再执行

诊断正在运行的 DSH、试跑插件、写版本豁免请用 DSH 里的面板 —— 那些需要宿主。
`)
  process.exit(0)
}

let home
try {
  home = resolveDshHome(flagValue(argv, 'home'))
} catch (error) {
  console.error(`找不到 DSH home: ${error instanceof Error ? error.message : String(error)}`)
  console.error('用 --home 指定，或先启动一次 DSH。')
  process.exit(1)
}

const profile = flagValue(argv, 'profile') ?? (() => {
  const profiles = listProfiles(home)
  if (profiles.length === 0) return 'desktop'
  // Most recently modified wins: that is almost always the one the user is running.
  return profiles.map((name) => ({ name, at: (() => {
    try { return Number(statSync(join(home, 'profiles', name)).mtimeMs) } catch { return 0 }
  })() })).sort((a, b) => b.at - a.at)[0].name
})()

const profileDir = join(home, 'profiles', profile)
if (!existsSync(profileDir)) {
  console.error(`profile "${profile}" 不存在：${profileDir}`)
  const known = listProfiles(home)
  if (known.length > 0) console.error(`现有的：${known.join(', ')}`)
  process.exit(1)
}

const key = randomBytes(24).toString('hex')

/** Open a URL in the default browser. Best effort: a headless box has none. */
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

const server = await startOutsideServer({
  home,
  profile,
  key,
  pollMs: 2_000,
})

console.log('')
console.log('  插件健康 · 局外工具')
console.log('  ' + server.url)
console.log('')
console.log(`  profile : ${profile}`)
console.log(`  home    : ${home}`)
console.log(`  同步    : ${server.mode() === 'watch' ? '文件监听（即时）' : '定时检查'}`)
console.log('')
if (!argv.includes('--no-open')) {
  const opened = openBrowser(server.url)
  if (!opened) console.log('  （无法自动打开浏览器，请手动访问上面的地址）')
}
console.log('  按 Ctrl+C 停止。')
console.log('')

// Leave the server running until interrupted. This process is the tool.
await new Promise((resolve) => {
  const stop = () => { resolve(undefined) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
})

await server.close()
console.log('\n  已停止。')
