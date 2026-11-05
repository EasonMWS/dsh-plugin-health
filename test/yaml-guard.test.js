import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDocument } from 'yaml'

import { MAX_YAML_ANCHORS, yamlComplexityProblem } from '../src/util/yaml-guard.js'

// The first guard matched anchor names with [A-Za-z0-9_-], so `&.a` or `&中` passed it untouched while
// still costing seconds in parseDocument. YAML allows almost any non-space character in an anchor name.
for (const name of ['a', '.a', '中', '!a', '~a', '/a', '@a']) {
  test(`an alias bomb is refused whatever the anchor is called (${name})`, () => {
    const text = `- id: x\n  config: {k: &${name} 1, ` + Array.from({ length: 14000 }, (_, i) => `k${i}: *${name}`).join(', ') + '}\n'
    const started = performance.now()
    assert.match(String(yamlComplexityProblem(text)), /anchors or aliases/u)
    assert.ok(performance.now() - started < 1000, 'the guard itself must stay cheap')
  })
}

test('deeply nested flow collections are refused before the parser sees them', () => {
  const text = '- id: x\n  config: ' + '['.repeat(200000) + ']'.repeat(200000) + '\n'
  assert.match(String(yamlComplexityProblem(text)), /nested deeper/u)
})

test('ordinary patches pass, including asterisks inside strings', () => {
  const text = '- id: x\n  config: {a: [1, {b: [2, 3]}], glob: "*.js", note: "[[{"}\n- id: y\n  config: {c: &base 1, d: *base}\n'
  assert.equal(yamlComplexityProblem(text), undefined)
  assert.equal(parseDocument(text).errors.length, 0)
})

test('the limit is exactly the documented number', () => {
  const at = (n) => '- id: x\n  config: {k: &a 1, ' + Array.from({ length: n - 1 }, (_, i) => `k${i}: *a`).join(', ') + '}\n'
  assert.equal(yamlComplexityProblem(at(MAX_YAML_ANCHORS)), undefined)
  assert.notEqual(yamlComplexityProblem(at(MAX_YAML_ANCHORS + 1)), undefined)
})
