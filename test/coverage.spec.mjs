/**
 * The lines the behavioural specs reach only indirectly: name attribution, the
 * configuration's refusals, the depth bound, and the accounting the snapshot
 * exposes.
 *
 * These exist because defect injection asks a different question than a
 * behaviour test does. A mutation that turns one of these lines off has to make
 * *something* go red, or the line is a claim nothing checks — so each test here
 * is written against a mutation that was measured, and the file is the record of
 * which mutations the suite can see.
 *
 * @module test/coverage.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_DEPTH, isMcpName, matchServer, normalizeConfig, normalizeSchema, unknownTypes, TYPE_PREFERENCE,
} from '../lib/index.js'
import { instance, propose, publicToolName, service, world } from './harness.mjs'

/** Narrow with the default settings, asserting a result came back. */
function out(parameters, config = {}) {
  const result = normalizeSchema(parameters, normalizeConfig(config))
  assert.ok(result, 'expected a schema result')
  return result.schema
}

// --- name attribution ----------------------------------------------------

test('only a name in the MCP namespace is an MCP name', () => {
  assert.equal(isMcpName('mcp__github__search'), true)
  assert.equal(isMcpName('bash'), false)
  // A namespace marker that is not at the front is not a namespace: `includes`
  // would call this one an MCP tool and narrow a local tool's schema.
  assert.equal(isMcpName('local__mcp__search'), false)
  assert.equal(isMcpName('mcp'), false)
})

test('a prefix with nothing after it attributes no tool', () => {
  const rules = [{ name: 'github', prefix: 'mcp__github__' }]
  assert.deepEqual(matchServer('mcp__github__search', rules), { server: 'github', leaf: 'search' })
  // `mcp__github__` with an empty leaf is not a tool this server listed.
  assert.equal(matchServer('mcp__github__', rules), undefined)
  // A prefix that does not match at all selects nothing, which is read as
  // "not selected" rather than "selected anyway".
  assert.equal(matchServer('mcp__gitlab__search', rules), undefined)
})

test('the longest configured prefix owns the name', () => {
  // Two servers where one key extends the other both prefix the same tool name.
  const rules = [
    { name: 'github', prefix: 'mcp__github__' },
    { name: 'github__enterprise', prefix: 'mcp__github__enterprise__' },
  ]
  assert.deepEqual(matchServer('mcp__github__enterprise__search', rules), {
    server: 'github__enterprise',
    leaf: 'search',
  })
  // The order the operator wrote them in must not decide it.
  assert.deepEqual(matchServer('mcp__github__enterprise__search', [...rules].reverse()), {
    server: 'github__enterprise',
    leaf: 'search',
  })
  assert.deepEqual(matchServer('mcp__github__search', rules), { server: 'github', leaf: 'search' })
  // Two rules with the *same* prefix cannot be told apart by length, so the
  // operator's own order decides — the first one written wins.
  const twins = [{ name: 'first', prefix: 'mcp__x__' }, { name: 'second', prefix: 'mcp__x__' }]
  assert.deepEqual(matchServer('mcp__x__tool', twins), { server: 'first', leaf: 'tool' })
})

// --- the configuration's refusals ----------------------------------------

test('a configuration that cannot be honoured fails the mount', () => {
  // A normalizer whose configuration was silently replaced by a default reports
  // success while doing something else, and the operator who wrote the typo is
  // the one person who cannot see it.
  assert.throws(() => normalizeConfig({ mode: 'narrow' }), /mode must be one of/)
  assert.throws(() => normalizeConfig({ report: 'yes' }), /must be a boolean/)
  assert.throws(() => normalizeConfig({ nullBranches: 1 }), /must be a boolean/)
  assert.throws(() => normalizeConfig({ servers: 'github' }), /must be an array of server names/)
  assert.throws(() => normalizeConfig({ servers: [''] }), /non-empty strings/)
  assert.throws(() => normalizeConfig({ prefer: 'string' }), /must be an array of type names/)
  assert.throws(() => normalizeConfig({ prefer: [1] }), /must contain strings/)
  assert.throws(() => normalizeConfig([]), /config must be an object/)
  assert.throws(() => normalizeConfig(null), /config must be an object/)
})

test('a preference order drops what it cannot honour and reports a fallback', () => {
  // An unknown name is dropped rather than rejected: one typo must not lose the
  // entries beside it. `null` is not a preference — a list that reached this step
  // has already had its null removed.
  assert.deepEqual(normalizeConfig({ prefer: ['array', 'bogus', 'null'] }).prefer, ['array'])
  // Nothing left is the one case that cannot be honoured, because it would make
  // every reduction arbitrary.
  const fell = normalizeConfig({ prefer: [] })
  assert.deepEqual(fell.prefer, [...TYPE_PREFERENCE])
  assert.equal(fell.preferFellBack, true)
  assert.equal(normalizeConfig({ prefer: ['string'] }).preferFellBack, false)
})

test('a configured server key that can never match is reported, not dropped', () => {
  // `mcp-client` validates `serverName` against `[A-Za-z0-9_-]{1,32}`, so a key
  // outside that shape cannot name a live server — but the configuration may be
  // carried across lines, so it is kept and the coverage report says why.
  const settings = normalizeConfig({ servers: ['has space'] })
  assert.equal(settings.servers[0].prefix, undefined)
  assert.match(settings.servers[0].unmatchableReason, /not a valid mcp-client serverName/)
  assert.equal(normalizeConfig({ servers: ['github'] }).servers[0].prefix, 'mcp__github__')
})

// --- the rules' edges ----------------------------------------------------

test('an empty type list is not a null branch', () => {
  // Reading `[]` as "constrains its value to nothing but null" would be true of
  // every member of an empty set and false of the declaration, so the union keeps
  // its branches.
  assert.deepEqual(out({ anyOf: [{ type: [] }, { type: 'object' }] }), { anyOf: [{ type: [] }, { type: 'object' }] })
  // A single-type list is already one type: nothing to repair.
  assert.deepEqual(out({ type: [] }), { type: [] })
})

test('a union of one object is not merged', () => {
  // The merge exists to make an either/or into one shape. With one branch there
  // is no either/or, and merging would hoist its properties onto the parent for
  // no reason.
  const schema = { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] }
  assert.deepEqual(out(schema), schema)
  // Two branches do merge: the union of `properties`, the intersection of
  // `required`.
  assert.deepEqual(out({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    ],
  }), { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } })
})

test('a schema deeper than the bound is registered unchanged rather than walked', () => {
  const leaf = { type: ['boolean', 'string'] }
  /** Nest `depth` object levels above a leaf. */
  const nested = depth => {
    let node = leaf
    for (let level = 0; level < depth; level += 1) node = { type: 'object', properties: { p: node } }
    return node
  }
  // Inside the bound the leaf is reached and narrowed.
  const inside = out(nested(3))
  assert.deepEqual(inside.properties.p.properties.p.properties.p, { type: 'string' })
  // Past the bound the walk stops, so the leaf keeps the server's own list: a
  // bound that silently narrowed it would be a bound this plugin never had.
  const beyond = out(nested(MAX_DEPTH + 1))
  let cursor = beyond
  for (let level = 0; level < MAX_DEPTH; level += 1) cursor = cursor.properties.p
  assert.deepEqual(cursor, { type: 'object', properties: { p: leaf } })
})

test('an unknown type name in a list is collected and does not become the type', () => {
  // A list that names something no validator knows is still a list, so it is
  // narrowed by the vocabulary that is left — and the name is reported, because
  // it is a shape this deployment has and the rule set does not describe.
  assert.deepEqual(unknownTypes({ type: ['string', 'widget'] }), ['widget'])
  assert.deepEqual(out({ type: ['string', 'widget'] }), { type: 'string' })
  assert.deepEqual(unknownTypes({ type: ['string', 'object'] }), [])
})

// --- the accounting ------------------------------------------------------

test('a union the rules did not cover is counted as such', async () => {
  const harness = await world()
  // A union of two primitives: legal, union-shaped, and not something any rule
  // repairs. It is the registration that says the rule set is incomplete for this
  // deployment, so it is counted rather than folded into "unchanged".
  propose(harness.ctx, publicToolName('search', 'find'), { anyOf: [{ type: 'string' }, { type: 'number' }] })
  const snapshot = service(harness).snapshot()
  assert.equal(snapshot.counters.unchanged, 1)
  assert.equal(snapshot.counters.unionButUnchanged, 1)
  // A schema with no union at all is unchanged without being counted here.
  propose(harness.ctx, publicToolName('search', 'other'), { type: 'object' })
  assert.equal(service(harness).snapshot().counters.unionButUnchanged, 1)
  await harness.dispose()
})

test('the unknown type names a deployment carries are reported once each', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'a'), { type: ['string', 'widget'] })
  propose(harness.ctx, publicToolName('search', 'b'), { type: ['object', 'widget'] })
  assert.deepEqual(service(harness).snapshot().unknownTypes, ['widget'])
  await harness.dispose()
})

test('only MCP names already in the registry are reported as pre-existing', async () => {
  // The warning this list feeds is "these MCP tools are already registered", so a
  // local tool that happened to be registered before the mount is not part of it.
  const harness = await world({ plugin: false })
  propose(harness.ctx, 'bash', { type: ['boolean', 'string'] })
  propose(harness.ctx, publicToolName('search', 'find'), { type: ['boolean', 'string'] })
  await harness.mount()
  assert.deepEqual(service(harness).snapshot().coverage.preExisting, ['mcp__search__find'])
  await harness.dispose()
})

test('the snapshot hands out its own arrays', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), { type: ['boolean', 'string'] })
  const first = service(harness).snapshot()
  assert.equal(first.changes.length, 1)
  // Every array in the snapshot is a copy: a reader that pushes into one must not
  // be able to change what the next reader sees.
  first.changes.push('not a change')
  first.coverage.preExisting.push('mcp__fake__tool')
  first.unknownTypes.push('fake')
  const second = service(harness).snapshot()
  assert.equal(second.changes.length, 1)
  assert.deepEqual(second.coverage.preExisting, [])
  assert.deepEqual(second.unknownTypes, [])
  await harness.dispose()
})

test('reset zeroes the counters, the rules and the log, and keeps the shadow', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), { type: ['boolean', 'string'] })
  const before = service(harness).snapshot()
  assert.equal(before.rules['narrow-type-list'], 1)
  assert.equal(before.counters.changes, 1)
  service(harness).reset()
  const after = service(harness).snapshot()
  assert.deepEqual(after.rules, {
    'narrow-type-list': 0, 'drop-null-branch': 0, 'drop-empty-union': 0, 'merge-object-branches': 0,
  })
  assert.equal(after.counters.changes, 0)
  assert.equal(after.counters.seen, 0)
  assert.deepEqual(after.changes, [])
  // The shadow and the configuration survive a reset: it is a counter reset, not
  // an unmount.
  assert.equal(after.patched, true)
  propose(harness.ctx, publicToolName('search', 'again'), { type: ['boolean', 'string'] })
  assert.equal(service(harness).snapshot().counters.narrowed, 1)
  await harness.dispose()
})

test('the snapshot says whether the shadow is installed', async () => {
  const harness = await world()
  // The service object is taken before the unmount: disposing the mount takes the
  // `provide` with it, and the reader that outlives a mount is the one that has to
  // be able to tell.
  const normalizer = service(harness)
  assert.equal(normalizer.snapshot().patched, true)
  await harness.dispose()
  assert.equal(service(harness), undefined)
  // After unmount the same object reads false — the difference between "nothing
  // needed narrowing" and "nothing can be narrowed any more".
  assert.equal(normalizer.snapshot().patched, false)
})

test('unmounting restores a registration that was already an own property', async () => {
  const harness = await world({ plugin: false })
  const inst = instance(harness.ctx, 'tools')
  // A plugin that mounted earlier and installed its own shadow on the instance:
  // this mount must put *that* back, not delete the property and let the
  // prototype's method show through.
  const foreign = function () { return () => {} }
  inst.register = foreign
  await harness.mount()
  assert.notEqual(inst.register, foreign)
  assert.equal(service(harness).snapshot().patched, true)
  await harness.dispose()
  assert.equal(inst.register, foreign)
  await harness.dispose()
})
