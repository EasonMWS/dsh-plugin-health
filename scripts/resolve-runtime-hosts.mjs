/**
 * The host versions the runtime acceptance job should test.
 *
 * Two moving targets and one fixed one:
 *
 *   - `latest` and `next`, resolved from the registry at run time, because the point of the job is to catch a
 *     host release breaking this tool before a user finds out. It used to be pinned to `0.2.1-rc.2` and
 *     `0.2.1-rc.3` while the current host was `0.2.2-rc.1`, so the job was testing releases nobody ran.
 *   - a fixed older release as a regression baseline, so a change that only breaks on the previous line is
 *     still caught.
 *
 * `latest` and `next` usually point at the same version. Emitting it twice would spend a whole job to learn
 * the same thing, so it is deduplicated.
 * @module scripts/resolve-runtime-hosts
 */

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** The oldest line the runtime job still has to keep working on. */
export const BASELINE_HOST = '0.2.1-rc.5'

/**
 * Pick the host versions to test from a registry dist-tags document.
 * @param {Record<string, string>} distTags - the `dist-tags` object for `@deepseek-ai/dsh`.
 * @param {{baseline?: string}} [options]
 * @returns {string[]} distinct versions, moving targets first.
 */
export function resolveRuntimeHosts(distTags, { baseline = BASELINE_HOST } = {}) {
  const hosts = []
  for (const name of ['latest', 'next']) {
    const version = distTags?.[name]
    if (typeof version !== 'string' || version === '') continue
    if (hosts.includes(version)) continue
    hosts.push(version)
  }
  if (!hosts.includes(baseline)) hosts.push(baseline)
  return hosts
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const raw = execFileSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], { encoding: 'utf8' })
  process.stdout.write(JSON.stringify(resolveRuntimeHosts(JSON.parse(raw))))
}