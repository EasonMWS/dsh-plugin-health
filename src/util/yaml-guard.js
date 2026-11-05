/**
 * Guard YAML parsing against inputs whose cost is not bounded by their size.
 *
 * `yaml`'s composer resolves aliases with work that grows with the square of the alias count, and
 * `maxAliasCount` only applies later, in `toJS`. So count anchors and aliases first, with the same
 * library's lexer: it is linear, and it recognises every anchor name YAML allows (`&.a`, `&中`, `&!x`),
 * which a hand-written regex cannot.
 * @module util/yaml-guard
 */
import { Lexer } from 'yaml'

/** Above this, a patch is not hand-written configuration. */
export const MAX_YAML_ANCHORS = 512

/** Flow collections nested deeper than this are not configuration either, and cost seconds to compose. */
export const MAX_YAML_FLOW_DEPTH = 64

/**
 * Why a text was rejected, or undefined when it is fine to parse.
 * @param {string} text
 * @returns {string|undefined}
 */
export function yamlComplexityProblem(text) {
  if (typeof text !== 'string' || text === '') return undefined
  let count = 0
  let depth = 0
  for (const token of new Lexer().lex(text)) {
    const first = token[0]
    if ((first === '*' || first === '&') && ++count > MAX_YAML_ANCHORS) {
      return `${count}+ anchors or aliases (limit ${MAX_YAML_ANCHORS}): parsing this would block the host`
    }
    if (token === '[' || token === '{') {
      if (++depth > MAX_YAML_FLOW_DEPTH) return `flow collections nested deeper than ${MAX_YAML_FLOW_DEPTH}: parsing this would block the host`
    } else if (token === ']' || token === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
  return undefined
}
