import test from 'node:test'
import assert from 'node:assert/strict'

import { isElectronRuntime, nodeCommand } from '../src/util/node-exec.js'

// The review's H2: on the desktop build the host is Electron, where `process.execPath` is the
// application binary. Spawning it with a script path launches a second copy of the app instead of
// running the script — so a rehearsal would open a window rather than boot a throwaway host, and a
// self-update would start a second DSH instead of installing anything.
//
// This shell inherits from DSH, which is itself Electron, so `ELECTRON_RUN_AS_NODE` is usually
// already present here. Every test below deletes it first, because the module must decide from the
// runtime, not from whatever an ancestor happened to export.

function withoutInheritedFlag(fn) {
  const saved = process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_RUN_AS_NODE
  try {
    return fn()
  } finally {
    if (saved !== undefined) process.env.ELECTRON_RUN_AS_NODE = saved
  }
}

/** Pretend this process is Electron for the duration of `fn`. */
function asElectron(fn) {
  Object.defineProperty(process.versions, 'electron', { value: '34.0.0', configurable: true })
  try {
    return withoutInheritedFlag(fn)
  } finally {
    delete process.versions.electron
  }
}

const hasPath = (env) => Object.keys(env).some((key) => /^path$/iu.test(key))

test('plain Node runs the script directly, with the environment untouched', () => {
  withoutInheritedFlag(() => {
    assert.equal(isElectronRuntime(), false)
    const command = nodeCommand()
    assert.equal(command.command, process.execPath)
    assert.equal(command.env.ELECTRON_RUN_AS_NODE, undefined, 'a plain Node run must not set the flag')
    assert.ok(hasPath(command.env), 'the caller environment is carried through')
    assert.notEqual(command.env, process.env, 'the result must be a copy, not the live object')
  })
})

test('Electron is detected from the runtime, and gets the flag that makes it behave as Node', () => {
  asElectron(() => {
    assert.equal(isElectronRuntime(), true)
    const command = nodeCommand()
    assert.equal(command.command, process.execPath)
    assert.equal(command.env.ELECTRON_RUN_AS_NODE, '1', 'without this the child is an app launch')
    assert.equal(command.electronAsNode, true)
    assert.ok(hasPath(command.env), 'the rest of the environment still reaches the child')
  })
})

test('a caller can supply its own path and environment', () => {
  asElectron(() => {
    const command = nodeCommand({ execPath: '/custom/node', env: { ONLY: 'this' } })
    assert.equal(command.command, '/custom/node')
    assert.equal(command.env.ONLY, 'this')
    assert.equal(command.env.ELECTRON_RUN_AS_NODE, '1')
  })
})

test('the module never mutates the environment it was handed', () => {
  asElectron(() => {
    const input = { KEEP: 'yes' }
    nodeCommand({ env: input })
    assert.deepEqual(input, { KEEP: 'yes' }, 'the caller object must not gain the flag')
  })
})
