/**
 * The rules, one at a time, against the shapes the report named.
 *
 * Every assertion here is about the schema a model would receive, not about an
 * internal representation: `normalizeSchema` is the function the registration
 * path calls, and its returned `schema` is what gets registered.
 *
 * @module test/normalize.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig, normalizeSchema } from '../lib/index.js'

const settings = normalizeConfig()

/** Narrow with the default settings. */
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

test('a two-type list loses its second member in favour of the preference order', () => {
  // The report's own example: a model that reads the list's first entry can
  // never send the string, and `string` is the member a caller most needs.
  assert.deepEqual(out({ type: ['boolean', 'string'] }), { type: 'string' })
  assert.deepEqual(rules({ type: ['boolean', 'string'] }), ['narrow-type-list'])
})

test('a type list keeps the preference order it was configured with', () => {
  assert.deepEqual(out({ type: ['boolean', 'string'] }, { prefer: ['boolean'] }), { type: 'boolean' })
  // A configured order that names none of the survivors falls back to the
  // server's own first entry rather than to a type the server never declared.
  assert.deepEqual(out({ type: ['integer', 'number'] }, { prefer: ['array'] }), { type: 'integer' })
})

test('"null" leaves a type list, and a null-only list keeps its null', () => {
  assert.deepEqual(out({ type: ['string', 'null'] }), { type: 'string' })
  assert.deepEqual(out({ type: ['null', 'object'] }), { type: 'object' })
  // A list of one is already one type: nothing to repair, nothing to report.
  assert.deepEqual(rules({ type: ['null'] }), [])
  assert.deepEqual(out({ type: ['null'] }), { type: ['null'] })
  // A list of nothing but nulls cannot be narrowed to a non-null type.
  assert.deepEqual(out({ type: ['null', 'null'] }), { type: 'null' })
})

test('nullBranches: false leaves a list that mixes null with other types alone', () => {
  assert.deepEqual(out({ type: ['string', 'null'] }, { nullBranches: false }), { type: ['string', 'null'] })
  // A list with no null is still narrowed: this flag is about null, not about
  // switching the plugin off.
  assert.deepEqual(out({ type: ['boolean', 'string'] }, { nullBranches: false }), { type: 'string' })
})

test('a type list that is not all strings is left exactly as the server wrote it', () => {
  const malformed = { type: ['string', 7] }
  assert.deepEqual(out(malformed), malformed)
  assert.deepEqual(rules(malformed), [])
})

test('an anyOf loses its null branches', () => {
  // The report's code-search server: `anyOf [array|string, null]`.
  const result = out({ anyOf: [{ type: 'array' }, { type: 'string' }, { type: 'null' }] })
  assert.deepEqual(result, { anyOf: [{ type: 'array' }, { type: 'string' }] })
  // And the survivors themselves are narrowed.
  assert.deepEqual(out({ anyOf: [{ type: ['array', 'string'] }, { type: 'null' }] }), { anyOf: [{ type: 'string' }] })
})

test('a oneOf of only nulls loses the keyword rather than becoming an empty union', () => {
  // An empty union accepts nothing, which is the opposite of this plugin's
  // purpose: dropping the keyword leaves the node's other keywords to speak.
  assert.deepEqual(out({ description: 'x', oneOf: [{ type: 'null' }] }), { description: 'x' })
  assert.deepEqual(rules({ oneOf: [{ type: 'null' }] }), ['drop-empty-union'])
})

test('a union whose branches are all objects merges into one object node', () => {
  const result = out({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
    ],
  })
  assert.deepEqual(result, {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
  })
  assert.deepEqual(rules({
    anyOf: [{ type: 'object' }, { type: 'object' }],
  }), ['merge-object-branches'])
})

test('the merge takes the first branch\'s schema for a name two branches declare', () => {
  // Order-dependence would make the result a function of iteration rather than
  // of the server's declaration, so the first branch wins and the test says so.
  const result = out({
    anyOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { a: { type: 'number' } } },
    ],
  })
  assert.deepEqual(result.properties, { a: { type: 'string' } })
})

test('the merge keeps required only where every branch required it', () => {
  const both = out({
    anyOf: [
      { type: 'object', properties: { a: {} }, required: ['a', 'b'] },
      { type: 'object', properties: { b: {} }, required: ['b'] },
    ],
  })
  assert.deepEqual(both.required, ['b'])
  const neither = out({ anyOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] })
  assert.equal('required' in neither, false)
})

test('the merge keeps additionalProperties only when every branch agreed on it', () => {
  // Pinned under `additionalProperties: 'keep'`: with the default `drop` the
  // keyword never survives to be observed, and this test is about the merge's own
  // decision — a decision that still matters for a deployment that keeps it.
  const keep = { additionalProperties: 'keep' }
  // The branches disagree (one says false, one says nothing), so the merge
  // cannot lift a value out of them and the node gets none.
  assert.equal(out({ anyOf: [{ type: 'object', additionalProperties: false }, { type: 'object' }] }, keep).additionalProperties, undefined)
  const agreed = out({
    anyOf: [{ type: 'object', additionalProperties: false }, { type: 'object', additionalProperties: false }],
  }, keep)
  assert.equal(agreed.additionalProperties, false)
  // A keyword the surrounding node already carried is not the merge's to
  // remove: the merge only decides what to lift *out of* the branches.
  const nodeOwn = out({ anyOf: [{ type: 'object' }, { type: 'object' }], additionalProperties: false }, keep)
  assert.equal(nodeOwn.additionalProperties, false)
})

test('a union with a non-object branch is left as a union', () => {
  const union = { anyOf: [{ type: 'object', properties: { a: {} } }, { type: 'string' }] }
  assert.deepEqual(out(union), union)
  assert.deepEqual(rules(union), [])
})

test('mergeObjectBranches: false keeps an object union as a union', () => {
  const union = { anyOf: [{ type: 'object' }, { type: 'object' }] }
  assert.deepEqual(out(union, { mergeObjectBranches: false }), union)
})

test('an object branch is recognized by its properties when it declares no type', () => {
  const result = out({ anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] })
  assert.deepEqual(result.properties, { a: {}, b: {} })
  assert.equal(result.type, 'object')
})

test('nested unions are reached wherever a subschema lives', () => {
  // Pinned under the two postures that keep `$defs` and `additionalProperties` in
  // place: pruning an unreferenced table and dropping the keyword are rules of
  // their own (test/refs.spec.mjs), and this test is about where narrowing reaches.
  const result = out({
    type: 'object',
    properties: { q: { type: ['array', 'string', 'null'] } },
    items: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    $defs: { inner: { type: ['boolean', 'string'] } },
    additionalProperties: { type: ['integer', 'string'] },
  }, { inlineRefs: false, additionalProperties: 'keep' })
  assert.deepEqual(result.properties.q, { type: 'string' })
  assert.deepEqual(result.items, { anyOf: [{ type: 'string' }] })
  assert.deepEqual(result.$defs.inner, { type: 'string' })
  assert.deepEqual(result.additionalProperties, { type: 'string' })
})

test('allOf is walked into but never restructured', () => {
  const result = out({ allOf: [{ type: ['string', 'null'] }] })
  assert.deepEqual(result, { allOf: [{ type: 'string' }] })
  assert.deepEqual(rules({ allOf: [{ type: ['string', 'null'] }] }), ['narrow-type-list'])
})

test('the input schema is never mutated', () => {
  const original = { type: 'object', properties: { q: { type: ['array', 'string', 'null'] } } }
  const before = JSON.stringify(original)
  const result = out(original)
  assert.equal(JSON.stringify(original), before)
  assert.notEqual(result, original)
  assert.notEqual(result.properties, original.properties)
})

test('a schema that is not an object has nothing to narrow', () => {
  assert.equal(normalizeSchema('nonsense', settings), undefined)
  assert.equal(normalizeSchema(null, settings), undefined)
  assert.equal(normalizeSchema([1, 2], settings), undefined)
  assert.equal(normalizeSchema(undefined, settings), undefined)
})

test('a schema with no union reports no change', () => {
  const plain = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  assert.deepEqual(rules(plain), [])
  assert.deepEqual(out(plain), plain)
})

test('a change records its path, its rule and both values', () => {
  const [change] = narrow({ properties: { q: { type: ['boolean', 'string'] } } }).changes
  assert.equal(change.path, '#/properties/q')
  assert.equal(change.rule, 'narrow-type-list')
  assert.deepEqual(change.before, ['boolean', 'string'])
  assert.equal(change.after, 'string')
})

test('recursion stops at the depth cap instead of walking a pathological schema', () => {
  let deep = { type: 'string' }
  for (let index = 0; index < 40; index += 1) deep = { properties: { q: deep } }
  const result = narrow(deep)
  // The cap is a floor on work, not a promise about the shape: what matters is
  // that the call returns and does not recurse without end.
  assert.ok(result.schema)
})
