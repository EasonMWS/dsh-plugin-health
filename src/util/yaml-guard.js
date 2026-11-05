/**
 * Guard YAML parsing against inputs whose cost is not bounded by their size.
 *
 * `yaml`'s parser resolves aliases while it parses, and its work grows with the square of the alias
 * count — 20k aliases in a 224KB file already cost two seconds, and the 1MB read limit therefore does
 * not bound anything. `maxAliasCount` only applies later, during `toJS`, which is seconds too late:
 * the event loop is already blocked. A plugin nobody ever loaded can ship such a patch, and every
 * status poll then stalls the whole host.
 *
 * The check is deliberately cheap and structural: count the alias and anchor tokens in the raw text
 * before handing it to the parser. A legitimate patch has none, or a handful.
 * @module util/yaml-guard
 */

/** Aliases are `*name`; anchors are `&name`. Both only matter outside plain scalars, but a raw count
 *  is the only thing that can be done before parsing, and over-counting is safe here. */
const ANCHOR_OR_ALIAS = /(?:^|[\s,[{:-])[&*][A-Za-z0-9_-]+/gu

/** Above this, a patch is not hand-written configuration. */
export const MAX_YAML_ANCHORS = 512

/**
 * Why a text was rejected, or undefined when it is fine to parse.
 * @param {string} text
 * @returns {string|undefined}
 */
export function yamlComplexityProblem(text) {
  if (typeof text !== 'string' || text === '') return undefined
  let count = 0
  for (const _ of text.matchAll(ANCHOR_OR_ALIAS)) {
    count += 1
    if (count > MAX_YAML_ANCHORS) {
      return `${count}+ anchors or aliases (limit ${MAX_YAML_ANCHORS}): parsing this would block the host`
    }
  }
  return undefined
}
