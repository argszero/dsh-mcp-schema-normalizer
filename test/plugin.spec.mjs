/**
 * The seam, end to end, through the real registry.
 *
 * `mcp-client` registers by name lookup through `ctx.tools`, so that is how these
 * tests register. The reading that decides every one of them is the registry's
 * own projection (`ctx.tools.schemas()`) — the same path the request assembly
 * takes — because "the definition was narrowed" and "the model would receive the
 * narrowed schema" are two different claims and only the second one is the point.
 *
 * @module test/plugin.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  instance, logText, projectedParameters, propose, publicToolName, registeredNames, shadowInstalled, world,
} from './harness.mjs'

const UNION = { type: 'object', properties: { query: { anyOf: [{ type: 'array' }, { type: 'string' }, { type: 'null' }] } } }
const NARROWED = { type: 'object', properties: { query: { anyOf: [{ type: 'array' }, { type: 'string' }] } } }

test('an MCP tool is registered with the narrowed schema the model receives', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__search__find'), NARROWED)
  await harness.dispose()
})

test('the narrowed definition is what reaches the layer underneath the shadow', async () => {
  // The recorder sits *under* the shadow, so what it saw is what the registry
  // was actually asked to hold — not what the plugin handed back.
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  assert.deepEqual(harness.recorder.seen.at(-1).parameters, NARROWED)
  await harness.dispose()
})

test('a tool outside the MCP namespace is left exactly as it was registered', async () => {
  const harness = await world()
  propose(harness.ctx, 'bash', UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'bash'), UNION)
  assert.deepEqual(harness.recorder.seen.at(-1).parameters, UNION)
  await harness.dispose()
})

test('a definition with no readable parameters is counted and forwarded', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), 'not a schema')
  assert.equal(harness.ctx.get('mcpSchemaNormalizer').snapshot().counters.unreadable, 1)
  await harness.dispose()
})

test('a schema with nothing to narrow is counted as unchanged', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), { type: 'object', properties: { q: { type: 'string' } } })
  const snapshot = harness.ctx.get('mcpSchemaNormalizer').snapshot()
  assert.equal(snapshot.counters.unchanged, 1)
  assert.equal(snapshot.counters.narrowed, 0)
  await harness.dispose()
})

test('naming servers narrows only those servers', async () => {
  const harness = await world({ config: { servers: ['github'] } })
  propose(harness.ctx, publicToolName('github', 'search'), UNION)
  propose(harness.ctx, publicToolName('gitlab', 'search'), UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__github__search'), NARROWED)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__gitlab__search'), UNION)
  const snapshot = harness.ctx.get('mcpSchemaNormalizer').snapshot()
  assert.equal(snapshot.counters.notSelected, 1)
  assert.deepEqual(snapshot.coverage.servers, [{ name: 'github', matched: 1 }])
  assert.equal(snapshot.coverage.serverLimited, true)
  await harness.dispose()
})

test('observing registers the server\'s own schema and reports what it would have changed', async () => {
  const harness = await world({ config: { mode: 'observe' } })
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__search__find'), UNION)
  assert.deepEqual(harness.recorder.seen.at(-1).parameters, UNION)
  const snapshot = harness.ctx.get('mcpSchemaNormalizer').snapshot()
  assert.equal(snapshot.counters.narrowed, 1)
  assert.equal(snapshot.counters.changes, 1)
  assert.equal(snapshot.changes[0].applied, false)
  assert.deepEqual(snapshot.changes[0].changes[0].rule, 'drop-null-branch')
  assert.equal(snapshot.changes[0].tool, 'mcp__search__find')
  await harness.dispose()
})

test('the rule counters add up over several registrations', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('s', 'a'), { type: ['boolean', 'string'] })
  propose(harness.ctx, publicToolName('s', 'b'), UNION)
  propose(harness.ctx, publicToolName('s', 'c'), { anyOf: [{ type: 'object' }, { type: 'object' }] })
  const snapshot = harness.ctx.get('mcpSchemaNormalizer').snapshot()
  assert.equal(snapshot.counters.narrowed, 3)
  assert.equal(snapshot.rules['narrow-type-list'], 1)
  assert.equal(snapshot.rules['drop-null-branch'], 1)
  assert.equal(snapshot.rules['merge-object-branches'], 1)
  assert.equal(snapshot.counters.seen, 3)
  await harness.dispose()
})

test('off mounts neither a shadow nor a service', async () => {
  const harness = await world({ config: { mode: 'off' } })
  assert.equal(shadowInstalled(harness), false)
  assert.equal(harness.ctx.get('mcpSchemaNormalizer'), undefined)
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__search__find'), UNION)
  await harness.dispose()
})

test('unmounting restores the registration the mount found', async () => {
  const harness = await world()
  assert.equal(shadowInstalled(harness), true)
  await harness.dispose()
  assert.equal(shadowInstalled(harness), false)
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__search__find'), UNION)
})

test('a tool registered before the mount is reported as pre-existing, not silently missed', async () => {
  const harness = await world({ plugin: false })
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  await harness.mount()
  const snapshot = harness.ctx.get('mcpSchemaNormalizer').snapshot()
  assert.deepEqual(snapshot.coverage.preExisting, ['mcp__search__find'])
  assert.match(logText(harness.logged), /already registered/)
  await harness.dispose()
})

test('a wrapper installed after the mount chains through it instead of calling itself', async () => {
  // Two plugins on one seam is the composition this family has already shipped
  // defects from. The plugin captured `register` at mount, so a wrapper installed
  // afterwards is above it: a registration passes the outer wrapper first, then
  // the plugin, then the layer the plugin captured. If the plugin had read
  // `ctx.tools.register` again instead of its captured function, the outer
  // wrapper would call the plugin, which would call the outer wrapper — a stack
  // overflow, not a narrowed schema.
  const harness = await world()
  const inst = instance(harness.ctx, 'tools')
  const seenByOuter = []
  const inner = inst.register
  inst.register = function (definition) {
    seenByOuter.push(definition.parameters)
    return inner.call(this, definition)
  }
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  // The outer wrapper sees the server's own schema, the plugin still narrows it,
  // and the narrowed schema is what the registry holds.
  assert.deepEqual(seenByOuter, [UNION])
  assert.deepEqual(harness.recorder.seen.at(-1).parameters, NARROWED)
  assert.deepEqual(projectedParameters(harness.ctx, 'mcp__search__find'), NARROWED)
  await harness.dispose()
})

test('registered names survive the shadow unchanged', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('search', 'find'), UNION)
  propose(harness.ctx, 'bash', {})
  assert.deepEqual(registeredNames(harness.ctx).sort(), ['bash', 'mcp__search__find'])
  await harness.dispose()
})

test('the first narrowing is logged once, not once per registration', async () => {
  const harness = await world()
  propose(harness.ctx, publicToolName('s', 'a'), { type: ['boolean', 'string'] })
  propose(harness.ctx, publicToolName('s', 'b'), { type: ['boolean', 'string'] })
  const text = logText(harness.logged)
  assert.equal(text.split('first narrowed schema').length - 1, 1)
  assert.match(text, /narrow-type-list/)
  await harness.dispose()
})

test('report: false quiets the mount and the first-change line', async () => {
  const harness = await world({ config: { report: false } })
  propose(harness.ctx, publicToolName('s', 'a'), { type: ['boolean', 'string'] })
  assert.equal(logText(harness.logged).includes('mcp-schema-normalizer'), false)
  await harness.dispose()
})
