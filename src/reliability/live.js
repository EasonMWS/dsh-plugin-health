// Cordis FiberState is a const enum. The DSH Loader's public inventory uses this same mapping.
const phases = ['pending', 'loading', 'active', 'failed', 'not-active', 'unloading']

export function readLiveEntries(ctx) {
  try {
    const entries = ctx?.get?.('loader')?.entries?.()
    if (typeof entries?.[Symbol.iterator] !== 'function') return null
    const rows = []
    for (const entry of entries) {
      const id = entry?.id ?? entry?.options?.id
      const name = entry?.options?.name
      if (entry?.options?.group || typeof id !== 'string' || typeof name !== 'string') continue
      const state = entry.disabled ? 'disabled' : phases[entry.fiber?.state] ?? 'not-active'
      // Some hosts retain the original Cordis error. Export only a recognized diagnostic and a
      // bounded identifier. Arbitrary messages can contain credentials, paths, or config values.
      const message = state === 'failed' ? entry.fiber?._error?.message : undefined
      const tool = typeof message === 'string'
        ? /^tool "([a-z0-9_.:-]{1,100})" is already registered\b/iu.exec(message)?.[1] : undefined
      rows.push({ id, name, state, ...(tool ? { diagnostic: { kind: 'duplicate-tool', tool } } : {}) })
    }
    return rows
  } catch {
    return null
  }
}

/** Sample only when the status endpoint is read. History lives in this running host instance. */
export function createLiveObserver() {
  let previous = null
  let scope
  let changes = []
  return (ctx, location, now = Date.now()) => {
    const key = JSON.stringify([location.home, location.profile])
    const entries = location.home && location.profile ? readLiveEntries(ctx) : null
    const sampledAt = new Date(now).toISOString()
    if (key !== scope || entries === null) {
      scope = key
      previous = null
      changes = []
    }
    if (entries === null) return null
    const next = new Map(entries.map(row => [JSON.stringify([row.id, row.name]), row]))
    if (previous !== null) {
      const found = []
      for (const [id, row] of next) {
        const before = previous.get(id)?.state ?? null
        if (before !== row.state) found.push({ id: row.id, name: row.name, before, after: row.state, sampledAt })
      }
      for (const [id, row] of previous) {
        if (!next.has(id)) found.push({ id: row.id, name: row.name, before: row.state, after: null, sampledAt })
      }
      if (found.length) changes = [...found, ...changes].slice(0, 24)
    }
    previous = next
    return { sampledAt, entries, changes }
  }
}
