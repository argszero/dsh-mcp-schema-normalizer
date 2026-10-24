/**
 * The two rules this plugin grew for a declaration-strict provider: local `$ref`
 * inlining (with the `$defs` table it leaves behind) and `additionalProperties`.
 *
 * The report behind them measured both against Gemini's `generateContent`: a
 * schema whose `parameters` carry `$ref`/`$defs` — or one `additionalProperties`
 * keyword — is rejected with HTTP 400 before any tool is called, so every turn of
 * the session fails. The assertions here are about the schema a model would
 * receive: `normalizeSchema` is what the registration path calls, and its
 * `schema` is what gets registered.
 *
 * @module test/refs.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig, normalizeSchema, resolveLocalRef } from '../lib/index.js'

/** Narrow with the given configuration and return the whole result. */
function narrow(parameters, config = {}) {
  const result = normalizeSchema(parameters, normalizeConfig(config))
  assert.ok(result, 'expected a schema result')
  return result
}

/** The narrowed schema alone. */
function out(parameters, config = {}) {
  return narrow(parameters, config).schema
}

/** The rules that fired, in order. */
function rules(parameters, config = {}) {
  return narrow(parameters, config).changes.map(change => change.rule)
}

// --- inlining -------------------------------------------------------------

test('a local $ref into $defs is replaced by the node it points at', () => {
  const schema = {
    type: 'object',
    properties: { query: { $ref: '#/$defs/Query' } },
    $defs: { Query: { type: 'string', description: 'what to look for' } },
  }
  assert.deepEqual(out(schema), {
    type: 'object',
    properties: { query: { type: 'string', description: 'what to look for' } },
  })
  // The `$defs` table nothing points into any more goes with it: it is a second
  // copy of a declaration the model now reads in place, and the reported
  // provider rejects the keyword itself.
  assert.deepEqual(rules(schema), ['inline-ref', 'prune-defs'])
})

test('a table nothing outside points into is pruned even when its own entries reference each other', () => {
  // The regression this pins: deciding "is this table still needed?" by scanning
  // the whole document answers *yes* for a table that only references itself, and
  // the dead table survives. The decision has to count references from outside the
  // table, which is what the reported provider's rejection is about — the keyword
  // itself, not whether the declarations are reachable.
  const schema = {
    type: 'object',
    properties: { q: { type: 'string' } },
    $defs: {
      A: { type: 'object', properties: { next: { $ref: '#/$defs/B' } } },
      B: { type: 'object', properties: { back: { $ref: '#/$defs/A' } } },
    },
  }
  const result = narrow(schema)
  assert.equal(result.schema.$defs, undefined)
  assert.deepEqual(result.schema.properties, { q: { type: 'string' } })
  // Nothing outside the table ever referenced it, so nothing is left unresolved:
  // the pruned references left with the table that held them.
  assert.deepEqual(result.unresolvedRefs, [])
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].rule, 'prune-defs')
})

test('the draft-07 spelling of the definitions table is followed too', () => {
  const schema = {
    type: 'object',
    properties: { limit: { $ref: '#/definitions/Limit' } },
    definitions: { Limit: { type: 'number' } },
  }
  assert.deepEqual(out(schema), { type: 'object', properties: { limit: { type: 'number' } } })
  assert.deepEqual(rules(schema), ['inline-ref', 'prune-defs'])
})

test('a nested definition is resolved to the node it names, not to the table', () => {
  const schema = {
    type: 'object',
    properties: { filter: { $ref: '#/$defs/Filter' } },
    $defs: {
      Filter: { type: 'object', properties: { tags: { $ref: '#/$defs/Tags' } } },
      Tags: { type: 'array', items: { type: 'string' } },
    },
  }
  assert.deepEqual(out(schema), {
    type: 'object',
    properties: { filter: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } } },
  })
})

test('pointer escapes are decoded before the lookup', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/odd~1name' }, b: { $ref: '#/$defs/til~0de' } },
    $defs: { 'odd/name': { type: 'string' }, 'til~de': { type: 'boolean' } },
  }
  assert.deepEqual(out(schema).properties, { a: { type: 'string' }, b: { type: 'boolean' } })
})

test('a percent-encoded pointer segment is decoded', () => {
  const root = { $defs: { 'a b': { type: 'string' } } }
  assert.deepEqual(resolveLocalRef(root, '#/$defs/a%20b'), { type: 'string' })
})

test('a sibling keyword written beside $ref overrides what the target declares', () => {
  const schema = {
    type: 'object',
    properties: { q: { $ref: '#/$defs/Q', description: 'overridden here' } },
    $defs: { Q: { type: 'string', description: 'from the target' } },
  }
  assert.deepEqual(out(schema).properties.q, { type: 'string', description: 'overridden here' })
})

test('inlined content is then narrowed, so a union inside $defs is repaired too', () => {
  const schema = {
    type: 'object',
    properties: { mode: { $ref: '#/$defs/Mode' } },
    $defs: { Mode: { type: ['boolean', 'string'] } },
  }
  assert.deepEqual(out(schema), { type: 'object', properties: { mode: { type: 'string' } } })
  assert.deepEqual(rules(schema), ['inline-ref', 'narrow-type-list', 'prune-defs'])
})

// --- what is deliberately left alone --------------------------------------

test('an external reference is left as written and reported', () => {
  const schema = { type: 'object', properties: { q: { $ref: 'https://example.test/schema.json#/Q' } } }
  const result = narrow(schema)
  assert.deepEqual(result.schema.properties.q, { $ref: 'https://example.test/schema.json#/Q' })
  assert.deepEqual(result.unresolvedRefs, ['https://example.test/schema.json#/Q'])
  assert.deepEqual(result.changes, [])
})

test('a dangling pointer keeps the table it would have pointed into', () => {
  const schema = {
    type: 'object',
    properties: { q: { $ref: '#/$defs/Missing' } },
    $defs: { Present: { type: 'string' } },
  }
  const result = narrow(schema)
  // The table stays: something still carries a `$ref`, and removing what it might
  // have pointed at would turn a diagnosable declaration into a broken one.
  assert.deepEqual(result.schema.$defs, { Present: { type: 'string' } })
  assert.deepEqual(result.unresolvedRefs, ['#/$defs/Missing'])
  assert.deepEqual(result.changes, [])
})

test('a cycle terminates and leaves the reference in place', () => {
  const schema = {
    type: 'object',
    properties: { node: { $ref: '#/$defs/A' } },
    $defs: {
      A: { type: 'object', properties: { next: { $ref: '#/$defs/B' } } },
      B: { type: 'object', properties: { back: { $ref: '#/$defs/A' } } },
    },
  }
  const result = narrow(schema)
  // A is inlined, B inside it, and the second reference to A stops the expansion.
  assert.deepEqual(result.schema.properties.node, {
    type: 'object',
    properties: { next: { type: 'object', properties: { back: { $ref: '#/$defs/A' } } } },
  })
  // Both references are reported, because both are still in the declaration the
  // model receives: the point of use carries the one that stopped the expansion,
  // and the table — untouched, since it is what those references point into —
  // carries the pair the server wrote.
  assert.deepEqual(result.unresolvedRefs, ['#/$defs/A', '#/$defs/B'])
  // The table stays for the same reason as a dangling pointer: a reference is
  // still in the declaration.
  assert.deepEqual(Object.keys(result.schema.$defs).sort(), ['A', 'B'])
})

test('a self-reference does not expand at all, so the declaration stays readable', () => {
  const schema = { type: 'object', properties: { self: { $ref: '#' } } }
  const result = narrow(schema)
  assert.deepEqual(result.schema.properties.self, { $ref: '#' })
  assert.deepEqual(result.unresolvedRefs, ['#'])
})

test('inlineRefs: false leaves references and the table exactly as the server wrote them', () => {
  const schema = {
    type: 'object',
    properties: { q: { $ref: '#/$defs/Q' } },
    $defs: { Q: { type: ['boolean', 'string'] } },
  }
  const result = narrow(schema, { inlineRefs: false })
  assert.deepEqual(result.schema.properties.q, { $ref: '#/$defs/Q' })
  assert.deepEqual(result.schema.$defs, { Q: { type: 'string' } })
  assert.deepEqual(rules(schema, { inlineRefs: false }), ['narrow-type-list'])
})

test('the schema a server sent is never mutated', () => {
  const schema = {
    type: 'object',
    properties: { q: { $ref: '#/$defs/Q' } },
    $defs: { Q: { type: ['boolean', 'string'], additionalProperties: false } },
  }
  const frozen = structuredClone(schema)
  narrow(schema)
  assert.deepEqual(schema, frozen)
})

// --- additionalProperties -------------------------------------------------

test('additionalProperties is dropped by default, whichever shape it has', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'object', properties: {}, additionalProperties: false },
      b: { type: 'object', properties: {}, additionalProperties: true },
    },
  }
  assert.deepEqual(out(schema), {
    type: 'object',
    properties: {
      a: { type: 'object', properties: {} },
      b: { type: 'object', properties: {} },
    },
  })
  assert.deepEqual(rules(schema), ['drop-additional-properties', 'drop-additional-properties'])
})

test('an object-valued additionalProperties is removed without being walked into', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'object', additionalProperties: { type: ['boolean', 'string'] } } },
  }
  const result = narrow(schema)
  assert.deepEqual(result.schema.properties.a, { type: 'object' })
  // No change record about a node this pass deleted: the only rule that fired is
  // the removal itself.
  assert.deepEqual(result.changes.map(change => change.rule), ['drop-additional-properties'])
})

test('additionalProperties: "keep" leaves the keyword and still reports nothing else', () => {
  const schema = { type: 'object', properties: { a: { type: 'object', additionalProperties: false } } }
  assert.deepEqual(out(schema, { additionalProperties: 'keep' }), schema)
  assert.deepEqual(rules(schema, { additionalProperties: 'keep' }), [])
})

test('a merge between object branches never re-introduces the keyword', () => {
  const schema = {
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: false },
    ],
  }
  const result = out(schema)
  assert.equal(result.additionalProperties, undefined)
  assert.deepEqual(Object.keys(result.properties).sort(), ['a', 'b'])
})

test('an invalid additionalProperties posture fails the mount instead of guessing', () => {
  assert.throws(() => normalizeConfig({ additionalProperties: 'remove' }), RangeError)
  assert.throws(() => normalizeConfig({ additionalProperties: 1 }), RangeError)
  assert.equal(normalizeConfig({}).additionalProperties, 'drop')
  assert.equal(normalizeConfig({ additionalProperties: 'keep' }).additionalProperties, 'keep')
})

test('inlineRefs must be a boolean', () => {
  assert.throws(() => normalizeConfig({ inlineRefs: 'yes' }), TypeError)
  assert.equal(normalizeConfig({}).inlineRefs, true)
})
