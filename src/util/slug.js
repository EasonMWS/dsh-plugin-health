/** `@scope/name` → `scope__name`; anything outside `[a-z0-9._-]` becomes `-`. Used for file names and anchors. */
export function slugOf(name) {
  return String(name).toLowerCase().replace(/^@/u, '').replace('/', '__').replace(/[^a-z0-9._-]/gu, '-')
}
