/**
 * Narrow one JSON Schema so a model that reads a union as its first member can
 * still fill the parameter.
 *
 * ## What is being repaired
 *
 * A tool parameter declared with a `type` list (`["boolean","string"]`), an
 * `anyOf` or a `oneOf` is legal JSON Schema and is what several MCP servers
 * actually publish (a code-search server declaring `anyOf [array|string, null]`
 * on its main parameters is the source report's example). Models that reduce a
 * union to its first entry — the reported one is Gemini — can then never produce
 * the other members, so a parameter that should accept a string accepts only a
 * boolean.
 *
 * The fix has to happen where the schema enters the process: our own tools are
 * ours to correct at the source, but an MCP server's `inputSchema` is third
 * party, and `createMcpToolDefinition` hands it to the registry unchanged
 * (`parameters: inputSchema`).
 *
 * ## The rules this plugin implements, from the report's out-of-tree patch
 *
 * Two rules that patch also carries are deliberately absent: it picks one branch
 * when a union is not all objects (this plugin leaves such a union and counts it
 * as `unionButUnchanged`), and it drops `null` from `enum` (this plugin leaves
 * `enum` alone). Both are stated in the README.
 *
 * - A `type` list loses `"null"`. If one type remains it becomes the node's
 *   `type`; if several remain, the first match in the preference order
 *   ({@link TYPE_PREFERENCE}) wins.
 * - `anyOf`/`oneOf` lose their null branches. A union with nothing left is
 *   dropped from the node, so the node accepts what its other keywords allow
 *   instead of accepting nothing.
 * - A union whose remaining branches are *all* objects is merged into one object
 *   node: the union of `properties`, the intersection of `required`.
 *
 * **The arguments sent to the server are never touched.** Narrowing the schema
 * only tells the model what it may send; the server still validates the call, and
 * what it accepts is a superset of what the narrowed schema admits.
 *
 * ## What this deliberately does not do
 *
 * It does not touch a node it cannot read as a plain JSON object, it does not
 * mutate the schema it was handed (the server's own object is left intact, and
 * the caller gets a copy), it does not invent a type that was not in the list,
 * and it does not error: a schema it cannot process is forwarded unchanged and
 * reported as `unreadable` rather than turning a mount into a failure.
 *
 * @module @argszero/dsh-mcp-schema-normalizer/normalize
 */

import { TYPE_NAMES } from './config.ts'
import type { Settings } from './config.ts'

/** A JSON Schema node, as it arrives from a server: unvalidated and possibly malformed. */
type Node = Record<string, unknown>

/** The rule that changed one node. */
export type Rule =
  /** A `type` list lost `"null"` and kept exactly one of the survivors. */
  | 'narrow-type-list'
  /** An `anyOf`/`oneOf` lost its null-only branches. */
  | 'drop-null-branch'
  /** An `anyOf`/`oneOf` lost every branch and was removed from the node. */
  | 'drop-empty-union'
  /** An `anyOf`/`oneOf` of objects became a single object node. */
  | 'merge-object-branches'

/** One keyword that changed, and what it was. */
export interface Change {
  /** Where in the schema, as a JSON-pointer-ish path rooted at `#`. */
  readonly path: string
  readonly rule: Rule
  /** The keyword's value before the change. */
  readonly before: unknown
  /** The keyword's value after the change. */
  readonly after: unknown
}

/** The narrowed schema and the account of what was narrowed. */
export interface NormalizeResult {
  /** The schema to register. A fresh object graph; the input is untouched. */
  readonly schema: Node
  readonly changes: readonly Change[]
}

/** Whether a value is a plain JSON object (not null, not an array). */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a node constrains its value to nothing but null.
 *
 * Both spellings a server may use are recognised (`type: "null"` and
 * `type: ["null"]`). A branch is judged by its `type` alone: an `enum: [null]`
 * branch is left in place, because reading it as a null branch would mean
 * deciding which other keywords also make a branch null, and a rule that is
 * right for the shapes seen in the field is worth more here than a rule that is
 * wrong for the shapes this plugin has never been shown.
 * @param branch - the union member.
 * @returns whether it is a null-only branch.
 */
export function isNullBranch(branch: unknown): boolean {
  if (!isNode(branch)) return false
  const type = branch['type']
  if (type === 'null') return true
  return Array.isArray(type) && type.length > 0 && type.every(entry => entry === 'null')
}

/**
 * Whether a union branch is an object constraint, for the merge rule.
 *
 * A branch is object-ish either by an explicit `"object"` type or, with no type
 * at all, by carrying `properties` — the shape a server emits when it lets the
 * schema speak for itself. A branch that says anything else (a string, an array,
 * or a node with no type and no properties) takes the union out of the merge.
 * @param branch - the union member.
 * @returns whether the branch constrains an object.
 */
function isObjectBranch(branch: unknown): boolean {
  if (!isNode(branch)) return false
  const type = branch['type']
  if (type === 'object') return true
  if (Array.isArray(type)) return type.includes('object')
  return type === undefined && isNode(branch['properties'])
}

/**
 * Reduce the survivors of a `type` list to the one type to keep.
 *
 * The preference order decides; an order that names none of the survivors falls
 * back to the first survivor, which keeps the result a function of the server's
 * own declaration rather than of a configuration that did not apply.
 * @param survivors - the type names left after `"null"` was removed. Never empty
 * for a list of more than one entry that was not all null.
 * @param prefer - the preference order.
 * @returns the single type name to keep.
 */
function pickType(survivors: readonly string[], prefer: readonly string[]): string {
  const first = survivors[0]
  // `survivors` is empty only for a list of nothing but nulls (`["null","null"]`),
  // where the honest reduction is the one type all of them named.
  if (first === undefined) return 'null'
  if (survivors.length === 1) return first
  return prefer.find(candidate => survivors.includes(candidate)) ?? first
}

/** The `type` keyword of a node as a list, or `undefined` when it is not a list. */
function typeList(node: Node): string[] | undefined {
  const type = node['type']
  if (!Array.isArray(type)) return undefined
  // A non-string entry is not a type name; the list is left alone rather than
  // filtered, because dropping an entry this plugin cannot read would narrow a
  // declaration on a guess.
  return type.every(entry => typeof entry === 'string') ? type as string[] : undefined
}

/** Immutably set a key, or delete it when the value is `undefined`. */
function withKey(node: Node, key: string, value: unknown): Node {
  const copy: Node = { ...node }
  if (value === undefined) delete copy[key]
  else copy[key] = value
  return copy
}

/**
 * Narrow one schema node and its descendants.
 * @param node - the node.
 * @param path - its path, for the change report.
 * @param settings - the resolved settings.
 * @param changes - the report being accumulated.
 * @param depth - the recursion depth, bounded by {@link MAX_DEPTH}.
 * @returns the narrowed node (a copy; the input is never mutated).
 */
function visit(node: Node, path: string, settings: Settings, changes: Change[], depth: number): Node {
  let out = node

  // 1. A type list loses "null"; one survivor becomes the type, several are
  //    reduced by the preference order. A list of one is already one type and is
  //    left as the server wrote it — rewriting `["string"]` into `"string"` would
  //    move a schema this plugin has nothing to repair, and would put a change in
  //    the report that no operator needs to read.
  const list = typeList(out)
  if (list !== undefined && list.length > 1 && (settings.nullBranches || !list.includes('null'))) {
    const narrowed = pickType(list.filter(entry => entry !== 'null'), settings.prefer)
    out = withKey(out, 'type', narrowed)
    changes.push({ path, rule: 'narrow-type-list', before: [...list], after: narrowed })
  }

  // 2. Recursion into the places a subschema can live.
  if (depth >= MAX_DEPTH) return out
  const child = (value: unknown, suffix: string): unknown => {
    if (isNode(value)) return visit(value, `${path}${suffix}`, settings, changes, depth + 1)
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        isNode(entry) ? visit(entry, `${path}${suffix}/${index}`, settings, changes, depth + 1) : entry)
    }
    return value
  }

  for (const key of ARRAY_SCHEMA_KEYS) {
    if (out[key] !== undefined) {
      const value = out[key]
      out = withKey(out, key, Array.isArray(value)
        ? value.map((entry, index) =>
          isNode(entry) ? visit(entry, `${path}/${key}/${index}`, settings, changes, depth + 1) : entry)
        : value)
    }
  }
  for (const key of MAP_SCHEMA_KEYS) {
    const value = out[key]
    if (!isNode(value)) continue
    const entries: Node = {}
    for (const [name, sub] of Object.entries(value)) {
      entries[name] = isNode(sub) ? visit(sub, `${path}/${key}/${name}`, settings, changes, depth + 1) : sub
    }
    out = withKey(out, key, entries)
  }
  for (const key of NODE_SCHEMA_KEYS) {
    const value = out[key]
    if (value === undefined) continue
    const next = child(value, `/${key}`)
    if (next !== value) out = withKey(out, key, next)
  }

  // 3. Unions: drop the null branches, then merge an all-object union.
  for (const key of UNION_KEYS) {
    const value = out[key]
    if (!Array.isArray(value)) continue
    // Narrow the branches first: a `["array","string"]` member of a union is a
    // union-shaped declaration too, and the merge below has to see what each
    // branch narrowed to before it can tell whether they are all objects.
    const original = value
    let branches = value.map((branch, index) =>
      isNode(branch) ? visit(branch, `${path}/${key}/${index}`, settings, changes, depth + 1) : branch)
    if (!branches.every((branch, index) => branch === value[index])) {
      out = withKey(out, key, branches)
    }

    if (settings.nullBranches) {
      const survivors = branches.filter(branch => !isNullBranch(branch))
      if (survivors.length !== branches.length) {
        branches = survivors
        if (survivors.length === 0) {
          // Nothing is left to accept. Keeping an empty union would make the
          // node accept nothing at all, which is the opposite of this plugin's
          // purpose; dropping the keyword leaves the node's other keywords to
          // say what it accepts.
          out = withKey(out, key, undefined)
          changes.push({ path: `${path}/${key}`, rule: 'drop-empty-union', before: original, after: undefined })
          continue
        }
        out = withKey(out, key, branches)
        changes.push({ path: `${path}/${key}`, rule: 'drop-null-branch', before: original, after: branches })
      }
    }

    if (settings.mergeObjectBranches && branches.length > 1 && branches.every(isObjectBranch)) {
      const merged = mergeObjects(branches)
      out = withKey(out, key, undefined)
      const properties = { ...(isNode(out['properties']) ? out['properties'] : {}), ...merged.properties }
      out = withKey(out, 'properties', properties)
      if (Object.keys(properties).length === 0) out = withKey(out, 'properties', undefined)
      if (merged.required.length > 0) {
        const existing = Array.isArray(out['required']) ? out['required'] : []
        const union = [...existing]
        for (const name of merged.required) if (!union.includes(name)) union.push(name)
        out = withKey(out, 'required', union)
      }
      if (merged.additionalProperties !== undefined && out['additionalProperties'] === undefined) {
        out = withKey(out, 'additionalProperties', merged.additionalProperties)
      }
      const nodeType = out['type']
      if (nodeType === undefined) out = withKey(out, 'type', 'object')
      changes.push({ path: `${path}/${key}`, rule: 'merge-object-branches', before: branches, after: { properties, required: merged.required } })
    }
  }

  return out
}

/**
 * Merge object branches into one object constraint.
 *
 * `properties` takes the first branch's schema for a name two branches declare,
 * so the result depends on the order the server wrote and not on the order the
 * plugin happened to iterate — a merge whose result changed with iteration order
 * would be a merge that is not reproducible. `required` is the intersection,
 * because a member only some branches required is not required by the union.
 * @param branches - the object branches, in the server's order.
 * @returns the merged pieces.
 */
function mergeObjects(branches: readonly unknown[]): {
  properties: Node
  required: string[]
  additionalProperties: unknown
} {
  const properties: Node = {}
  const perBranchRequired: string[][] = []
  let additional: unknown
  let additionalAgreed = true
  for (const branch of branches) {
    const node = branch as Node
    const own = node['properties']
    if (isNode(own)) {
      for (const [name, schema] of Object.entries(own)) {
        if (!(name in properties)) properties[name] = schema
      }
    }
    const required = node['required']
    perBranchRequired.push(Array.isArray(required) ? required.filter(entry => typeof entry === 'string') : [])
    if (additional === undefined) additional = node['additionalProperties']
    else if (additional !== node['additionalProperties']) additionalAgreed = false
  }
  const [first, ...rest] = perBranchRequired
  const required = first === undefined ? [] : first.filter(name => rest.every(list => list.includes(name)))
  return { properties, required, additionalProperties: additionalAgreed ? additional : undefined }
}

/** The depth past which a schema is registered unchanged rather than walked further. */
export const MAX_DEPTH = 32

/** Keywords whose value is an array of subschemas. */
const ARRAY_SCHEMA_KEYS: readonly string[] = ['prefixItems']

/** Keywords whose value is an object mapping names to subschemas. */
const MAP_SCHEMA_KEYS: readonly string[] = ['properties', '$defs', 'definitions']

/** Keywords whose value is one subschema (or, for `items`, one schema or a tuple list). */
const NODE_SCHEMA_KEYS: readonly string[] = [
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'additionalItems',
]

/** Keywords whose value is a list of alternative subschemas. */
const UNION_KEYS: readonly string[] = ['anyOf', 'oneOf']

/**
 * Narrow one tool's `parameters`.
 *
 * `allOf` is walked into but never restructured: intersecting schemas have no
 * single-type form, and inventing one would be this plugin deciding what a
 * server meant.
 * @param parameters - the schema a definition carried.
 * @param settings - the resolved settings.
 * @returns the narrowed schema and the change report, or `undefined` when the
 * input is not a plain object and there is nothing to narrow.
 */
export function normalizeSchema(parameters: unknown, settings: Settings): NormalizeResult | undefined {
  if (!isNode(parameters)) return undefined
  const changes: Change[] = []
  // `allOf` is a union-shaped keyword for walking purposes only.
  const schema = visit(parameters, '#', settings, changes, 0)
  const withAllOf = { ...schema }
  const allOf = withAllOf['allOf']
  if (Array.isArray(allOf)) {
    withAllOf['allOf'] = allOf.map((entry, index) =>
      isNode(entry) ? visit(entry, `#/allOf/${index}`, settings, changes, 1) : entry)
  }
  return { schema: withAllOf, changes }
}

/** Whether a schema contains anything this plugin knows how to narrow. */
export function hasUnion(parameters: unknown, depth = 0): boolean {
  if (!isNode(parameters) || depth > MAX_DEPTH) return false
  if (typeList(parameters) !== undefined) return true
  for (const key of UNION_KEYS) if (Array.isArray(parameters[key])) return true
  for (const key of [...MAP_SCHEMA_KEYS, ...NODE_SCHEMA_KEYS, ...ARRAY_SCHEMA_KEYS, 'allOf']) {
    const value = parameters[key]
    if (Array.isArray(value)) {
      if (value.some(entry => hasUnion(entry, depth + 1))) return true
    } else if (hasUnion(value, depth + 1)) return true
  }
  return false
}

/** Whether every entry of a `type` list is a known JSON Schema type name. */
export function unknownTypes(parameters: unknown, depth = 0, found: string[] = []): string[] {
  if (!isNode(parameters) || depth > MAX_DEPTH) return found
  const list = typeList(parameters)
  if (list !== undefined) {
    for (const entry of list) {
      if (typeof entry === 'string' && !TYPE_NAMES.includes(entry) && !found.includes(entry)) found.push(entry)
    }
  }
  for (const key of [...MAP_SCHEMA_KEYS, ...NODE_SCHEMA_KEYS, ...ARRAY_SCHEMA_KEYS, ...UNION_KEYS, 'allOf']) {
    const value = parameters[key]
    if (Array.isArray(value)) for (const entry of value) unknownTypes(entry, depth + 1, found)
    else unknownTypes(value, depth + 1, found)
  }
  return found
}
