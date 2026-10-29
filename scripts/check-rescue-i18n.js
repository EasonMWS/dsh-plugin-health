// One-off check: rescue UI must not contain hardcoded Chinese; everything goes through t().
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/ui/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function RescueCard')
const end = source.indexOf('function useRepair')
if (start === -1 || end === -1) { console.error('could not find the rescue component block'); process.exit(1) }
const block = source.slice(start, end)
const hardcoded = block.match(/['"`][^'"`\n]*[\u4e00-\u9fa5][^'"`\n]*['"`]/gu) ?? []
console.log('rescue component block: from', start, 'to', end, '(', block.length, 'chars )')
console.log('hardcoded Chinese literals:', hardcoded.length)
for (const literal of hardcoded.slice(0, 10)) console.log('  ', literal.slice(0, 70))
// Also confirm every t() key used exists in both dictionaries.
const keys = [...block.matchAll(/\bt\('([^']+)'/gu)].map(match => match[1])
const zh = source.slice(source.indexOf('zh: {'), source.indexOf('en: {'))
const en = source.slice(source.indexOf('en: {'), source.indexOf('dictionaries = {') === -1 ? source.length : source.indexOf('for (const [language, findings]'))
console.log('t() keys used:', [...new Set(keys)].join(', '))
for (const key of new Set(keys)) {
  const inZh = new RegExp(`\\b${key}:`, 'u').test(zh)
  const inEn = new RegExp(`\\b${key}:`, 'u').test(en)
  if (!inZh || !inEn) console.error(`MISSING key ${key}: zh=${inZh} en=${inEn}`)
}
