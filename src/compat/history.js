/**
 * What changed, and when: daily snapshots of the page's verdicts, and the transitions between them.
 *
 * A single day's table says a plugin is rejected. Only a history says it has been rejected since 3 November,
 * or that it was fixed two days after the host moved. That is also the one part of this data that cannot be
 * recreated later by anyone who starts scanning today.
 *
 * Snapshots are compact (a few hundred KB for the whole catalogue) and kept by date. Events are derived by
 * comparing consecutive snapshots, so a missed day only delays an event; it never invents one.
 */

/** @typedef {{v: string, s: Record<string, 'ok'|'bad'|'err'>}} SnapshotRow */
/** @typedef {{date: string, hosts: string[], latest: string|null, rows: Record<string, SnapshotRow>}} Snapshot */

/**
 * Reduce a matrix to what history needs.
 * @param {object} matrix
 * @param {string} date - YYYY-MM-DD.
 * @returns {Snapshot}
 */
export function snapshotOf(matrix, date) {
  const hosts = [...(matrix.hosts ?? [])]
  const latest = hosts.find((host) => matrix.hostRoles?.[host] === 'latest') ?? hosts[0] ?? null
  const rows = {}
  for (const plugin of matrix.plugins ?? []) {
    const s = {}
    for (const host of hosts) {
      const compatible = plugin.results?.[host]?.compatible
      s[host] = compatible === true ? 'ok' : compatible === false ? 'bad' : 'err'
    }
    rows[plugin.name] = { v: plugin.version ?? '', s }
  }
  return { date, hosts, latest, rows }
}

/**
 * Transitions between two snapshots, judged on the newer snapshot's latest host.
 *
 * Comparing on one host keeps the events meaningful: a plugin does not "break" because a new preview column
 * appeared, only because the host people run rejects it. When the latest host itself changed between the two
 * snapshots, a plugin that was fine before and is rejected now is recorded as `broken-by-host`; when only the
 * plugin's version changed, the cause is the release, and the event says `fixed` or `broken-by-release`.
 *
 * @param {Snapshot|null} previous
 * @param {Snapshot} current
 * @returns {Array<{date: string, name: string, kind: string, host: string, from?: string, to?: string, version: string}>}
 */
export function diffSnapshots(previous, current) {
  const host = current.latest
  if (!previous || !host) return []
  const hostMoved = previous.latest !== host
  const events = []
  for (const [name, row] of Object.entries(current.rows)) {
    const before = previous.rows[name]
    const now = row.s[host]
    if (!before) {
      events.push({ date: current.date, name, kind: 'added', host, version: row.v, state: now })
      continue
    }
    // Compare against the old snapshot's verdict on the same host when it had one; otherwise its latest.
    const was = before.s[host] ?? (previous.latest ? before.s[previous.latest] : undefined)
    if (was === now) continue
    const versionChanged = before.v !== row.v
    let kind
    if (was === 'bad' && now === 'ok') kind = 'fixed'
    else if (was === 'ok' && now === 'bad') kind = versionChanged ? 'broken-by-release' : (hostMoved ? 'broken-by-host' : 'broken')
    else continue
    events.push({ date: current.date, name, kind, host, from: before.v, to: row.v, version: row.v })
  }
  return events
}

/**
 * Per plugin, the dates a reader cares about: when its current state began, and its last fix.
 * @param {Array<{date: string, name: string, kind: string}>} events - oldest first.
 * @returns {Map<string, {since?: string, state?: 'ok'|'bad', lastFixed?: string, events: number}>}
 */
export function summarizeHistory(events) {
  const summary = new Map()
  for (const event of events) {
    const entry = summary.get(event.name) ?? { events: 0 }
    entry.events += 1
    if (event.kind === 'fixed') {
      entry.lastFixed = event.date
      entry.since = event.date
      entry.state = 'ok'
    } else if (event.kind.startsWith('broken')) {
      entry.since = event.date
      entry.state = 'bad'
    } else if (event.kind === 'added') {
      entry.since ??= event.date
      entry.state ??= event.state === 'bad' ? 'bad' : event.state === 'ok' ? 'ok' : undefined
    }
    summary.set(event.name, entry)
  }
  return summary
}
