/** This package's own identity, recorded in every document it writes so a reader knows which rules made it. */
import { readFileSync } from 'node:fs'

const OWN_MANIFEST = new URL('../../package.json', import.meta.url)

/** `{ name, version }` of this tool, read from its own manifest. */
export function toolIdentity() {
  try {
    const manifest = JSON.parse(readFileSync(OWN_MANIFEST, 'utf8'))
    return { name: manifest.name, version: manifest.version }
  } catch {
    return { name: 'dsh-plugin-health', version: null }
  }
}
