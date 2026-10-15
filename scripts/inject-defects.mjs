#!/usr/bin/env node
/**
 * Defect injection: every arm mutates one line of `src/`, rebuilds, and runs the
 * real suite. An arm is **CAUGHT** when the suite goes red — which is the only
 * evidence that the tests measure the behaviour the line implements. An arm that
 * leaves the suite green is **SILENT** (the tests do not cover that line) and an
 * arm that does not compile is **NOT-COMPILED** (it proves nothing about the
 * tests). Both are failures of this script.
 *
 * Every file is held in memory and restored in a `finally`, and the run refuses
 * to finish without verifying every file is byte-identical to what it read — a
 * killed run must not leave a mutated tree behind, because the next run would
 * then measure a tree that is already wrong.
 *
 * Run: `npm run test:inject`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const TSC = join(root, 'node_modules', '.bin', 'tsc')

/**
 * The specs an arm is measured against: the three behavioural ones.
 *
 * `test/packaging.spec.mjs` is deliberately not here — it reads `package.json`,
 * the README and the probe script, none of which an arm touches — so that the
 * arms below measure behaviour and nothing else. `npm test` runs all four.
 */
const SPECS = ['test/normalize.spec.mjs', 'test/plugin.spec.mjs', 'test/coverage.spec.mjs']

/** Every file an arm may touch, with its original bytes. */
const FILES = ['src/detect.ts', 'src/config.ts', 'src/normalize.ts', 'src/normalizer.ts', 'src/index.ts']
const original = new Map(FILES.map(file => [file, readFileSync(join(root, file), 'utf8')]))

/**
 * One mutation: a unique source fragment and what it becomes.
 *
 * The fragment must occur exactly once, so an arm cannot silently mutate a
 * different line than the one it names.
 */
const ARMS = [
  // --- detect.ts ---------------------------------------------------------
  {
    id: 'detect/is-mcp-name-uses-includes',
    file: 'src/detect.ts',
    find: '  return name.startsWith(MCP_PREFIX)',
    replace: '  return name.includes(MCP_PREFIX)',
  },
  {
    id: 'detect/empty-leaf-is-attributed',
    file: 'src/detect.ts',
    find: '    if (leaf.length === 0) continue',
    replace: '    if (leaf.length < 0) continue',
  },
  {
    id: 'detect/shorter-prefix-wins',
    file: 'src/detect.ts',
    find: '    if (best !== undefined && prefix.length <= name.length - best.leaf.length) continue',
    replace: '    if (best !== undefined && prefix.length < name.length - best.leaf.length) continue',
  },
  {
    id: 'detect/first-prefix-wins',
    file: 'src/detect.ts',
    find: '    if (best !== undefined && prefix.length <= name.length - best.leaf.length) continue',
    replace: '    if (best !== undefined) continue',
  },

  // --- config.ts ---------------------------------------------------------
  {
    id: 'config/servers-default-is-none',
    file: 'src/config.ts',
    find: "  if (servers === undefined) return []",
    replace: "  if (servers === undefined) return ['none']",
  },
  {
    id: 'config/bare-string-servers-accepted',
    file: 'src/config.ts',
    find: '  if (!Array.isArray(servers)) {',
    replace: '  if (!Array.isArray(servers) && typeof servers !== \'string\') {',
  },
  {
    id: 'config/unknown-prefer-name-kept',
    file: 'src/config.ts',
    find: "    if (entry === 'null' || !TYPE_NAMES.includes(entry)) continue",
    replace: "    if (entry === 'null') continue",
  },
  {
    id: 'config/prefer-empty-does-not-fall-back',
    file: 'src/config.ts',
    find: '  return order.length === 0 ? { order: [...TYPE_PREFERENCE], fellBack: true } : { order, fellBack: false }',
    replace: '  return { order, fellBack: false }',
  },
  {
    id: 'config/non-boolean-is-coerced',
    file: 'src/config.ts',
    find: "  if (typeof value !== 'boolean') {\n    throw new TypeError(`mcp-schema-normalizer: ${field} must be a boolean, got ${describe(value)}`)\n  }\n  return value",
    replace: '  return Boolean(value)',
  },
  {
    id: 'config/unknown-mode-accepted',
    file: 'src/config.ts',
    find: '  if (!MODES.includes(mode)) {',
    replace: '  if (!MODES.includes(mode) && false) {',
  },
  {
    id: 'config/unmatchable-key-gets-a-prefix',
    file: 'src/config.ts',
    find: '        : { name, prefix: undefined, unmatchableReason: reason }',
    replace: '        : { name, prefix: `${MCP_PREFIX}${name}${SERVER_SEPARATOR}` }',
  },
  {
    id: 'config/non-object-config-accepted',
    file: 'src/config.ts',
    find: "  if (config === null || typeof config !== 'object' || Array.isArray(config)) {",
    replace: '  if (config === null) {',
  },

  // --- normalize.ts ------------------------------------------------------
  {
    id: 'normalize/null-branch-empty-list',
    file: 'src/normalize.ts',
    find: "  return Array.isArray(type) && type.length > 0 && type.every(entry => entry === 'null')",
    replace: "  return Array.isArray(type) && type.every(entry => entry === 'null')",
  },
  {
    id: 'normalize/single-null-is-not-a-branch',
    file: 'src/normalize.ts',
    find: "  if (type === 'null') return true",
    replace: "  if (type === 'null') return false",
  },
  {
    id: 'normalize/object-branch-by-type-only',
    file: 'src/normalize.ts',
    find: '  return type === undefined && isNode(branch[\'properties\'])',
    replace: '  return type === undefined && isNode(branch[\'properties\']) && false',
  },
  {
    id: 'normalize/object-branch-rejects-explicit-object',
    file: 'src/normalize.ts',
    find: "  if (type === 'object') return true",
    replace: '  if (type === \'object\') return false',
  },
  {
    id: 'normalize/pick-type-ignores-preference',
    file: 'src/normalize.ts',
    find: '  return prefer.find(candidate => survivors.includes(candidate)) ?? first',
    replace: '  return first',
  },
  {
    id: 'normalize/pick-type-empty-survivors',
    file: 'src/normalize.ts',
    find: "  if (first === undefined) return 'null'",
    replace: "  if (first === undefined) return 'string'",
  },
  {
    id: 'normalize/length-one-list-is-rewritten',
    file: 'src/normalize.ts',
    find: '  if (list !== undefined && list.length > 1 && (settings.nullBranches || !list.includes(\'null\'))) {',
    replace: "  if (list !== undefined && list.length > 0 && (settings.nullBranches || !list.includes('null'))) {",
  },
  // NOT AN ARM — recorded so the line is not mistaken for an untested one.
  // `pickType(list.filter(entry => entry !== 'null'), prefer)` and
  // `pickType(list, prefer)` are the same function on every input: `prefer` can
  // never contain `'null'` (`readPrefer` drops it), so the preference lookup
  // never selects it, and on a list of nothing but nulls both paths answer
  // `'null'`. Measured SILENT, and it is EQUIVALENT: the filter is documentation
  // of intent, not a branch the suite could distinguish.
  {
    id: 'normalize/nullBranches-setting-ignored',
    file: 'src/normalize.ts',
    find: '  if (list !== undefined && list.length > 1 && (settings.nullBranches || !list.includes(\'null\'))) {',
    replace: '  if (list !== undefined && list.length > 1) {',
  },
  {
    id: 'normalize/empty-union-kept',
    file: 'src/normalize.ts',
    find: '          out = withKey(out, key, undefined)\n          changes.push({ path: `${path}/${key}`, rule: \'drop-empty-union\', before: original, after: undefined })',
    replace: '          changes.push({ path: `${path}/${key}`, rule: \'drop-empty-union\', before: original, after: undefined })',
  },
  {
    id: 'normalize/merge-ignores-the-setting',
    file: 'src/normalize.ts',
    find: '    if (settings.mergeObjectBranches && branches.length > 1 && branches.every(isObjectBranch)) {',
    replace: '    if (branches.length > 1 && branches.every(isObjectBranch)) {',
  },
  {
    id: 'normalize/single-branch-union-merged',
    file: 'src/normalize.ts',
    find: '    if (settings.mergeObjectBranches && branches.length > 1 && branches.every(isObjectBranch)) {',
    replace: '    if (settings.mergeObjectBranches && branches.length > 0 && branches.every(isObjectBranch)) {',
  },
  {
    id: 'normalize/required-is-the-union',
    file: 'src/normalize.ts',
    find: '  const required = first === undefined ? [] : first.filter(name => rest.every(list => list.includes(name)))',
    replace: '  const required = first === undefined ? [] : [...first]',
  },
  {
    id: 'normalize/properties-last-branch-wins',
    file: 'src/normalize.ts',
    find: '        if (!(name in properties)) properties[name] = schema',
    replace: '        properties[name] = schema',
  },
  {
    id: 'normalize/additional-properties-always-kept',
    file: 'src/normalize.ts',
    find: '  return { properties, required, additionalProperties: additionalAgreed ? additional : undefined }',
    replace: '  return { properties, required, additionalProperties: additional }',
  },
  {
    id: 'normalize/write-mutates-the-input',
    file: 'src/normalize.ts',
    find: 'function withKey(node: Node, key: string, value: unknown): Node {\n  const copy: Node = { ...node }',
    replace: 'function withKey(node: Node, key: string, value: unknown): Node {\n  const copy: Node = node',
  },
  {
    id: 'normalize/depth-limit-removed',
    file: 'src/normalize.ts',
    find: '  if (depth >= MAX_DEPTH) return out',
    replace: '  if (depth >= MAX_DEPTH + 4096) return out',
  },
  {
    id: 'normalize/non-string-type-list-is-read',
    file: 'src/normalize.ts',
    find: '  return type.every(entry => typeof entry === \'string\') ? type as string[] : undefined',
    replace: '  return type as string[]',
  },

  // --- normalizer.ts -----------------------------------------------------
  {
    id: 'normalizer/observe-applies-anyway',
    file: 'src/normalizer.ts',
    find: "    const applied = this.mode === 'normalize'",
    replace: '    const applied = true',
  },
  {
    id: 'normalizer/normalize-forwards-untouched',
    file: 'src/normalizer.ts',
    find: "    const applied = this.mode === 'normalize'",
    replace: '    const applied = false',
  },
  {
    id: 'normalizer/unreadable-counts-as-unchanged',
    file: 'src/normalizer.ts',
    find: '    if (result.changes.length === 0) {',
    replace: '    if (result.changes.length >= 0) {',
  },
  {
    id: 'normalizer/union-but-unchanged-not-counted',
    file: 'src/normalizer.ts',
    find: '      if (hasUnion(parameters)) this.unionUnchanged += 1',
    replace: '      if (false) this.unionUnchanged += 1',
  },
  {
    id: 'normalizer/unknown-types-not-collected',
    file: 'src/normalizer.ts',
    find: '    for (const entry of unknownTypes(parameters)) {',
    replace: '    for (const entry of [] as readonly string[]) {',
  },
  {
    id: 'normalizer/seeded-flag-never-set',
    file: 'src/normalizer.ts',
    find: '    this.preExisting = names.filter(name => name.startsWith(\'mcp__\'))',
    replace: '    this.preExisting = [...names]',
  },
  {
    id: 'normalizer/server-match-count-not-incremented',
    file: 'src/normalizer.ts',
    find: '    this.preExisting = names.filter(name => name.startsWith(\'mcp__\'))',
    replace: '    this.preExisting = []',
  },
  {
    id: 'normalizer/snapshot-does-not-own-its-arrays',
    file: 'src/normalizer.ts',
    find: '      changes: [...this.log],',
    replace: '      changes: this.log,',
  },
  {
    id: 'normalizer/reset-leaves-the-rule-counts',
    file: 'src/normalizer.ts',
    find: '    this.ruleCounts = emptyRules()\n    this.log = []',
    replace: '    this.log = []',
  },

  // --- index.ts ----------------------------------------------------------
  {
    id: 'index/off-mode-still-mounts',
    file: 'src/index.ts',
    find: "  if (settings.mode === 'off') return",
    replace: "  if (settings.mode === 'off' && false) return",
  },
  {
    id: 'index/wrapper-rereads-the-service',
    file: 'src/index.ts',
    find: '        return normalizer.handle(definition, (next: unknown) => original.call(this, next as ToolDefinition))',
    replace: '        return normalizer.handle(definition, (next: unknown) => ctx.tools.register(next as ToolDefinition))',
  },
  {
    id: 'index/writes-the-view-not-the-instance',
    file: 'src/index.ts',
    find: '    const underlying = (Reflect.get(view as object, ORIGINAL) as ToolRuntime | undefined) ?? view',
    replace: '    const underlying = view',
  },
  {
    id: 'index/unmount-always-deletes',
    file: 'src/index.ts',
    find: '        if (ownRegister) Reflect.set(underlying, \'register\', original)\n        else Reflect.deleteProperty(underlying, \'register\')',
    replace: '        Reflect.deleteProperty(underlying, \'register\')',
  },
  {
    id: 'index/unmount-does-not-restore',
    file: 'src/index.ts',
    find: '        if (ownRegister) Reflect.set(underlying, \'register\', original)\n        else Reflect.deleteProperty(underlying, \'register\')',
    replace: '        if (ownRegister) void original',
  },
  {
    id: 'index/pre-existing-names-never-seeded',
    file: 'src/index.ts',
    find: '      normalizer.notePreExisting(liveNames(view))',
    replace: '      normalizer.notePreExisting([])',
  },
  {
    id: 'index/patched-stays-true-after-unmount',
    file: 'src/index.ts',
    find: '      normalizer.patched = false\n      if (settings.report) ctx.logger.info(`mcp-schema-normalizer: unmounted',
    replace: '      if (settings.report) ctx.logger.info(`mcp-schema-normalizer: unmounted',
  },
]

/** Run one command, returning whether it succeeded and its combined output. */
function run(command, args) {
  try {
    const stdout = execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, output: stdout }
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    return { ok: false, output: `${stdout}${stderr}` }
  }
}

/** Restore every file, and refuse to continue if any of them is not byte-identical. */
function restore() {
  for (const [file, text] of original) writeFileSync(join(root, file), text)
  const drifted = FILES.filter(file => readFileSync(join(root, file), 'utf8') !== original.get(file))
  if (drifted.length > 0) throw new Error(`source not restored: ${drifted.join(', ')}`)
}

const results = []
try {
  // The baseline has to be green, or every arm below measures the wrong thing.
  const build0 = run(TSC, ['--noEmitOnError'])
  if (!build0.ok) throw new Error(`baseline tsc failed:\n${build0.output}`)
  const base = run(process.execPath, ['--test', ...SPECS])
  if (!base.ok) throw new Error(`baseline suite failed:\n${base.output}`)
  const baselineCount = /pass (\d+)/.exec(base.output)?.[1] ?? '?'
  console.log(`baseline: green (${baselineCount} passing)\n`)

  for (const arm of ARMS) {
    const source = original.get(arm.file)
    const occurrences = source.split(arm.find).length - 1
    if (occurrences !== 1) {
      results.push({ id: arm.id, verdict: 'BAD-ARM', detail: `fragment occurs ${occurrences} times` })
      console.log(`  BAD-ARM  ${arm.id} — fragment occurs ${occurrences} times`)
      continue
    }
    writeFileSync(join(root, arm.file), source.replace(arm.find, arm.replace))
    // `--noEmitOnError`: an arm that does not compile must not leave a broken
    // `lib/` behind, or the next arm's test run would measure that build.
    const build = run(TSC, ['--noEmitOnError'])
    if (!build.ok) {
      results.push({ id: arm.id, verdict: 'NOT-COMPILED', detail: '' })
      console.log(`  NOT-COMPILED ${arm.id}`)
      restore()
      continue
    }
    const tests = run(process.execPath, ['--test', ...SPECS])
    const verdict = tests.ok ? 'SILENT' : 'CAUGHT'
    const failed = /fail (\d+)/.exec(tests.output)?.[1] ?? '?'
    results.push({ id: arm.id, verdict, detail: tests.ok ? '' : `${failed} failing` })
    console.log(`  ${verdict.padEnd(12)} ${arm.id}${tests.ok ? '' : ` (${failed} failing)`}`)
    restore()
  }
} finally {
  restore()
  // `lib/` is built output: restore what the last arm left, and prove the
  // restoration by rebuilding from the restored sources.
  run(TSC, ['--noEmitOnError'])
}

const tally = verdict => results.filter(result => result.verdict === verdict).length
console.log(`\n${results.length} arms — ${tally('CAUGHT')} CAUGHT, ${tally('SILENT')} SILENT, `
  + `${tally('NOT-COMPILED')} NOT-COMPILED, ${tally('BAD-ARM')} BAD-ARM`)
if (tally('CAUGHT') !== results.length) {
  for (const bad of results.filter(result => result.verdict !== 'CAUGHT')) {
    console.log(`  ${bad.verdict}: ${bad.id}${bad.detail === '' ? '' : ` — ${bad.detail}`}`)
  }
  process.exit(1)
}
console.log('every arm is CAUGHT: the suite measures each injected line.')
