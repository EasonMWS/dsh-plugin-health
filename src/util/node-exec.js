/**
 * How to start a Node process from inside DSH.
 *
 * The plugin runs inside the host, and on the desktop build that host is Electron. There,
 * `process.execPath` is `DeepSeek Harness.exe`, so spawning it with a script path starts a second
 * copy of the application instead of running the script — which is exactly what the review's H2
 * warning described: a rehearsal would open a window rather than boot a throwaway host.
 *
 * Electron honours `ELECTRON_RUN_AS_NODE=1` and behaves as plain Node, so the fix is an environment
 * variable rather than a different executable: there is no separate `node` binary shipped with the
 * desktop build to point at.
 * @module util/node-exec
 */

/**
 * Whether this process is Electron rather than plain Node.
 *
 * Electron sets `process.versions.electron`; Node never does. The check is deliberately about the
 * runtime rather than the product, because a CLI install on the same machine must take the plain
 * path.
 * @returns {boolean}
 */
export function isElectronRuntime() {
  return typeof process.versions?.electron === 'string'
}

/**
 * The executable plus the environment needed to make it behave as Node.
 *
 * Callers spread `env` over their own environment. Passing it is not optional when this returns
 * `electronAsNode: true`: without the flag the child is an application launch, not a script run.
 * @param {{execPath?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{command: string, env: Record<string, string|undefined>, electronAsNode: boolean}}
 */
export function nodeCommand({ execPath = process.execPath, env = process.env } = {}) {
  const electron = isElectronRuntime()
  return {
    command: execPath,
    env: electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : { ...env },
    electronAsNode: electron,
  }
}