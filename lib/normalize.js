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
import { TYPE_NAMES } from "./config.js";
/** Whether a value is a plain JSON object (not null, not an array). */
function isNode(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export function isNullBranch(branch) {
    if (!isNode(branch))
        return false;
    const type = branch['type'];
    if (type === 'null')
        return true;
    return Array.isArray(type) && type.length > 0 && type.every(entry => entry === 'null');
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
function isObjectBranch(branch) {
    if (!isNode(branch))
        return false;
    const type = branch['type'];
    if (type === 'object')
        return true;
    if (Array.isArray(type))
        return type.includes('object');
    return type === undefined && isNode(branch['properties']);
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
function pickType(survivors, prefer) {
    const first = survivors[0];
    // `survivors` is empty only for a list of nothing but nulls (`["null","null"]`),
    // where the honest reduction is the one type all of them named.
    if (first === undefined)
        return 'null';
    if (survivors.length === 1)
        return first;
    return prefer.find(candidate => survivors.includes(candidate)) ?? first;
}
/** The `type` keyword of a node as a list, or `undefined` when it is not a list. */
function typeList(node) {
    const type = node['type'];
    if (!Array.isArray(type))
        return undefined;
    // A non-string entry is not a type name; the list is left alone rather than
    // filtered, because dropping an entry this plugin cannot read would narrow a
    // declaration on a guess.
    return type.every(entry => typeof entry === 'string') ? type : undefined;
}
/** Immutably set a key, or delete it when the value is `undefined`. */
function withKey(node, key, value) {
    const copy = { ...node };
    if (value === undefined)
        delete copy[key];
    else
        copy[key] = value;
    return copy;
}
/**
 * A reference this plugin can follow: the whole document (`#`) or a pointer into
 * it (`#/a/b`). A URL, a bare name or a fragment that is not a pointer is not
 * local, and is left exactly as the server wrote it.
 */
const LOCAL_POINTER = /^#(\/.*)?$/;
/** Keywords whose value is a table of named subschemas a `$ref` may point into. */
const DEFINITION_KEYS = ['$defs', 'definitions'];
/**
 * Decode one JSON Pointer segment.
 *
 * The fragment form of a pointer is URI-encoded as well as `~`-escaped, so both
 * layers are undone. A malformed percent-escape cannot make this throw: the raw
 * segment is used instead, and the pointer then simply fails to resolve.
 * @param segment - one `~`-escaped pointer segment.
 * @returns the property name it names.
 */
function decodeSegment(segment) {
    const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!unescaped.includes('%'))
        return unescaped;
    try {
        return decodeURIComponent(unescaped);
    }
    catch {
        return unescaped;
    }
}
/**
 * Resolve a local reference against the schema it appeared in.
 *
 * Only a `#`-rooted pointer is resolved. Everything else — an external URL, a
 * fragment that is not a pointer, a pointer into a node that does not exist —
 * returns `undefined`, which the caller reports rather than guesses at: an
 * inlined node that does not match what the server meant is worse than a
 * declaration the model can still read the way the server wrote it.
 * @param root - the schema the reference is read against, exactly as it arrived.
 * @param ref - the `$ref` value.
 * @returns the node it points at, or `undefined` when this plugin cannot follow it.
 */
export function resolveLocalRef(root, ref) {
    if (!LOCAL_POINTER.test(ref))
        return undefined;
    const rest = ref.slice(1);
    if (rest === '')
        return root;
    let cursor = root;
    for (const raw of rest.slice(1).split('/')) {
        const key = decodeSegment(raw);
        if (Array.isArray(cursor)) {
            // An array index in a pointer is a decimal string, never a leading-zero or
            // negative form, so anything else is a pointer this plugin does not follow.
            if (!/^(?:0|[1-9]\d*)$/.test(key))
                return undefined;
            const index = Number(key);
            if (index >= cursor.length)
                return undefined;
            cursor = cursor[index];
            continue;
        }
        if (!isNode(cursor) || !Object.hasOwn(cursor, key))
            return undefined;
        cursor = cursor[key];
    }
    return cursor;
}
/**
 * Every `$ref` a finished schema still carries, deduplicated, in walk order.
 * @param node - the schema.
 * @param depth - the recursion depth.
 * @param found - the accumulator.
 * @param outsideDefinitions - skip the root's `$defs`/`definitions` tables. Used
 * for the pruning decision: whether a table is still **used** is a question about
 * the references outside it, since a table always carries the references it was
 * written with.
 * @returns the references, as written.
 */
export function collectRefs(node, depth = 0, found = [], outsideDefinitions = false) {
    if (!isNode(node) || depth > MAX_DEPTH)
        return found;
    const ref = node['$ref'];
    if (typeof ref === 'string' && !found.includes(ref))
        found.push(ref);
    for (const [key, value] of Object.entries(node)) {
        if (outsideDefinitions && depth === 0 && DEFINITION_KEYS.includes(key))
            continue;
        if (Array.isArray(value)) {
            for (const entry of value)
                collectRefs(entry, depth + 1, found, outsideDefinitions);
        }
        else
            collectRefs(value, depth + 1, found, outsideDefinitions);
    }
    return found;
}
/** How many references one schema may expand before the rest are left in place. */
export const MAX_REF_EXPANSIONS = 512;
/**
 * Expand every local reference in a schema, before any other rule runs.
 *
 * Cycle detection is by **node identity**, not by reference string: a reference
 * whose target is already being expanded on this branch points back into
 * something this pass is currently in the middle of copying, and expanding it
 * again is what turns a self-referential schema into a document of unbounded
 * depth. Two different pointers to the same node are therefore caught by the same
 * test, which is the condition that actually fails to terminate.
 * @param node - the node to expand.
 * @param path - its path, for the change report.
 * @param changes - the report being accumulated.
 * @param env - the pass state.
 * @param depth - the recursion depth, bounded by {@link MAX_DEPTH}.
 * @returns the expanded node (a copy; the input is never mutated).
 */
function expandReferences(node, path, changes, env, depth) {
    if (depth >= MAX_DEPTH)
        return node;
    let out = node;
    // Children first, so a keyword written beside `$ref` is expanded before the
    // merge below lets it override the target.
    const child = (value, suffix) => {
        if (isNode(value))
            return expandReferences(value, `${path}${suffix}`, changes, env, depth + 1);
        if (Array.isArray(value)) {
            return value.map((entry, index) => isNode(entry) ? expandReferences(entry, `${path}${suffix}/${index}`, changes, env, depth + 1) : entry);
        }
        return value;
    };
    const rebuild = (key, value) => {
        if (Array.isArray(value)) {
            const next = value.map((entry, index) => isNode(entry) ? expandReferences(entry, `${path}/${key}/${index}`, changes, env, depth + 1) : entry);
            if (next.some((entry, index) => entry !== value[index]))
                out = withKey(out, key, next);
            return;
        }
        const next = child(value, `/${key}`);
        if (next !== value)
            out = withKey(out, key, next);
    };
    for (const key of ARRAY_SCHEMA_KEYS)
        if (out[key] !== undefined)
            rebuild(key, out[key]);
    for (const key of MAP_SCHEMA_KEYS) {
        // A definitions table is not expanded in place. Its entries reach the model
        // through the references that point at them — which resolve against this table
        // and are expanded where they are used — and a table this pass cannot repair
        // (a dangling pointer, a cycle) stays exactly as the server wrote it.
        if (DEFINITION_KEYS.includes(key))
            continue;
        const value = out[key];
        if (!isNode(value))
            continue;
        let changed = false;
        const entries = {};
        for (const [name, sub] of Object.entries(value)) {
            const next = isNode(sub) ? expandReferences(sub, `${path}/${key}/${name}`, changes, env, depth + 1) : sub;
            entries[name] = next;
            if (next !== sub)
                changed = true;
        }
        if (changed)
            out = withKey(out, key, entries);
    }
    for (const key of NODE_SCHEMA_KEYS)
        if (out[key] !== undefined)
            rebuild(key, out[key]);
    for (const key of [...UNION_KEYS, 'allOf']) {
        const value = out[key];
        if (Array.isArray(value))
            rebuild(key, value);
    }
    const ref = out['$ref'];
    if (typeof ref !== 'string')
        return out;
    const target = resolveLocalRef(env.root, ref);
    // Left in place: an unfollowable reference, a cycle, or a schema that has already
    // expanded its budget. The snapshot reports every `$ref` the final schema still
    // carries, so none of these needs recording here.
    if (!isNode(target) || env.active.has(target) || env.expansions >= MAX_REF_EXPANSIONS)
        return out;
    env.expansions += 1;
    env.active.add(target);
    let expanded;
    try {
        expanded = expandReferences(target, `${path}/$ref`, changes, env, depth + 1);
    }
    finally {
        env.active.delete(target);
    }
    changes.push({ path, rule: 'inline-ref', before: ref, after: 'inlined' });
    const merged = { ...expanded };
    for (const [key, value] of Object.entries(out)) {
        if (key !== '$ref')
            merged[key] = value;
    }
    return merged;
}
/**
 * Narrow one schema node and its descendants.
 * @param node - the node.
 * @param path - its path, for the change report.
 * @param settings - the resolved settings.
 * @param changes - the report being accumulated.
 * @param depth - the recursion depth, bounded by {@link MAX_DEPTH}.
 * @param env - the pass state.
 * @returns the narrowed node (a copy; the input is never mutated).
 */
function visit(node, path, settings, changes, depth) {
    let out = node;
    // 1. A type list loses "null"; one survivor becomes the type, several are
    //    reduced by the preference order. A list of one is already one type and is
    //    left as the server wrote it — rewriting `["string"]` into `"string"` would
    //    move a schema this plugin has nothing to repair, and would put a change in
    //    the report that no operator needs to read.
    const list = typeList(out);
    if (list !== undefined && list.length > 1 && (settings.nullBranches || !list.includes('null'))) {
        const narrowed = pickType(list.filter(entry => entry !== 'null'), settings.prefer);
        out = withKey(out, 'type', narrowed);
        changes.push({ path, rule: 'narrow-type-list', before: [...list], after: narrowed });
    }
    // 2. `additionalProperties` is removed when asked for. Done before the recursion
    //    so an object-valued keyword is not walked into and reported on after the
    //    node that carried it has been deleted.
    if (settings.additionalProperties === 'drop' && Object.hasOwn(out, 'additionalProperties')) {
        const before = out['additionalProperties'];
        out = withKey(out, 'additionalProperties', undefined);
        changes.push({ path: `${path}/additionalProperties`, rule: 'drop-additional-properties', before, after: undefined });
    }
    // 3. Recursion into the places a subschema can live.
    if (depth >= MAX_DEPTH)
        return out;
    const child = (value, suffix) => {
        if (isNode(value))
            return visit(value, `${path}${suffix}`, settings, changes, depth + 1);
        if (Array.isArray(value)) {
            return value.map((entry, index) => isNode(entry) ? visit(entry, `${path}${suffix}/${index}`, settings, changes, depth + 1) : entry);
        }
        return value;
    };
    for (const key of ARRAY_SCHEMA_KEYS) {
        if (out[key] !== undefined) {
            const value = out[key];
            out = withKey(out, key, Array.isArray(value)
                ? value.map((entry, index) => isNode(entry) ? visit(entry, `${path}/${key}/${index}`, settings, changes, depth + 1) : entry)
                : value);
        }
    }
    for (const key of MAP_SCHEMA_KEYS) {
        const value = out[key];
        if (!isNode(value))
            continue;
        const entries = {};
        for (const [name, sub] of Object.entries(value)) {
            entries[name] = isNode(sub) ? visit(sub, `${path}/${key}/${name}`, settings, changes, depth + 1) : sub;
        }
        out = withKey(out, key, entries);
    }
    for (const key of NODE_SCHEMA_KEYS) {
        const value = out[key];
        if (value === undefined)
            continue;
        const next = child(value, `/${key}`);
        if (next !== value)
            out = withKey(out, key, next);
    }
    // 4. Unions: drop the null branches, then merge an all-object union.
    for (const key of UNION_KEYS) {
        const value = out[key];
        if (!Array.isArray(value))
            continue;
        // Narrow the branches first: a `["array","string"]` member of a union is a
        // union-shaped declaration too, and the merge below has to see what each
        // branch narrowed to before it can tell whether they are all objects.
        const original = value;
        let branches = value.map((branch, index) => isNode(branch) ? visit(branch, `${path}/${key}/${index}`, settings, changes, depth + 1) : branch);
        if (!branches.every((branch, index) => branch === value[index])) {
            out = withKey(out, key, branches);
        }
        if (settings.nullBranches) {
            const survivors = branches.filter(branch => !isNullBranch(branch));
            if (survivors.length !== branches.length) {
                branches = survivors;
                if (survivors.length === 0) {
                    // Nothing is left to accept. Keeping an empty union would make the
                    // node accept nothing at all, which is the opposite of this plugin's
                    // purpose; dropping the keyword leaves the node's other keywords to
                    // say what it accepts.
                    out = withKey(out, key, undefined);
                    changes.push({ path: `${path}/${key}`, rule: 'drop-empty-union', before: original, after: undefined });
                    continue;
                }
                out = withKey(out, key, branches);
                changes.push({ path: `${path}/${key}`, rule: 'drop-null-branch', before: original, after: branches });
            }
        }
        if (settings.mergeObjectBranches && branches.length > 1 && branches.every(isObjectBranch)) {
            const merged = mergeObjects(branches);
            out = withKey(out, key, undefined);
            const properties = { ...(isNode(out['properties']) ? out['properties'] : {}), ...merged.properties };
            out = withKey(out, 'properties', properties);
            if (Object.keys(properties).length === 0)
                out = withKey(out, 'properties', undefined);
            if (merged.required.length > 0) {
                const existing = Array.isArray(out['required']) ? out['required'] : [];
                const union = [...existing];
                for (const name of merged.required)
                    if (!union.includes(name))
                        union.push(name);
                out = withKey(out, 'required', union);
            }
            if (merged.additionalProperties !== undefined && out['additionalProperties'] === undefined) {
                out = withKey(out, 'additionalProperties', merged.additionalProperties);
            }
            const nodeType = out['type'];
            if (nodeType === undefined)
                out = withKey(out, 'type', 'object');
            changes.push({ path: `${path}/${key}`, rule: 'merge-object-branches', before: branches, after: { properties, required: merged.required } });
        }
    }
    return out;
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
function mergeObjects(branches) {
    const properties = {};
    const perBranchRequired = [];
    let additional;
    let additionalAgreed = true;
    for (const branch of branches) {
        const node = branch;
        const own = node['properties'];
        if (isNode(own)) {
            for (const [name, schema] of Object.entries(own)) {
                if (!(name in properties))
                    properties[name] = schema;
            }
        }
        const required = node['required'];
        perBranchRequired.push(Array.isArray(required) ? required.filter(entry => typeof entry === 'string') : []);
        if (additional === undefined)
            additional = node['additionalProperties'];
        else if (additional !== node['additionalProperties'])
            additionalAgreed = false;
    }
    const [first, ...rest] = perBranchRequired;
    const required = first === undefined ? [] : first.filter(name => rest.every(list => list.includes(name)));
    return { properties, required, additionalProperties: additionalAgreed ? additional : undefined };
}
/** The depth past which a schema is registered unchanged rather than walked further. */
export const MAX_DEPTH = 32;
/** Keywords whose value is an array of subschemas. */
const ARRAY_SCHEMA_KEYS = ['prefixItems'];
/** Keywords whose value is an object mapping names to subschemas. */
const MAP_SCHEMA_KEYS = ['properties', '$defs', 'definitions'];
/** Keywords whose value is one subschema (or, for `items`, one schema or a tuple list). */
const NODE_SCHEMA_KEYS = [
    'items',
    'additionalProperties',
    'not',
    'contains',
    'propertyNames',
    'if',
    'then',
    'else',
    'additionalItems',
];
/** Keywords whose value is a list of alternative subschemas. */
const UNION_KEYS = ['anyOf', 'oneOf'];
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
export function normalizeSchema(parameters, settings) {
    if (!isNode(parameters))
        return undefined;
    const changes = [];
    const env = { root: parameters, active: new Set([parameters]), expansions: 0 };
    // Expansion first, so the rules below see what each reference actually declares
    // instead of a node they cannot read into.
    const expanded = settings.inlineRefs ? expandReferences(parameters, '#', changes, env, 0) : parameters;
    // `allOf` is a union-shaped keyword for walking purposes only.
    const schema = visit(expanded, '#', settings, changes, 0);
    let withAllOf = { ...schema };
    const allOf = withAllOf['allOf'];
    if (Array.isArray(allOf)) {
        withAllOf['allOf'] = allOf.map((entry, index) => isNode(entry) ? visit(entry, `#/allOf/${index}`, settings, changes, 1) : entry);
    }
    // A `$defs` table is a second copy of declarations the model would otherwise
    // read in place: with inlining on and nothing left pointing into it, it is dead
    // weight in a declaration that has a token budget, and on the reported provider
    // a `$defs` key in the declaration is itself rejected. Only removed when the
    // walk left no `$ref` behind — a table something still points at is one keeping
    // a reference resolvable.
    if (settings.inlineRefs && collectRefs(withAllOf, 0, [], true).length === 0) {
        for (const key of DEFINITION_KEYS) {
            const table = withAllOf[key];
            if (!isNode(table))
                continue;
            const names = Object.keys(table);
            withAllOf = { ...withAllOf };
            delete withAllOf[key];
            changes.push({ path: `#/${key}`, rule: 'prune-defs', before: names, after: undefined });
            // The definitions were walked before this decision could be made; their
            // per-node records describe nodes this same pass deleted, so they are
            // dropped rather than left to look like changes that reached the model.
            for (let index = changes.length - 2; index >= 0; index -= 1) {
                if (changes[index]?.path.startsWith(`#/${key}/`))
                    changes.splice(index, 1);
            }
        }
    }
    return { schema: withAllOf, changes, unresolvedRefs: collectRefs(withAllOf) };
}
/** Whether a schema contains anything this plugin knows how to narrow. */
export function hasUnion(parameters, depth = 0) {
    if (!isNode(parameters) || depth > MAX_DEPTH)
        return false;
    if (typeList(parameters) !== undefined)
        return true;
    for (const key of UNION_KEYS)
        if (Array.isArray(parameters[key]))
            return true;
    for (const key of [...MAP_SCHEMA_KEYS, ...NODE_SCHEMA_KEYS, ...ARRAY_SCHEMA_KEYS, 'allOf']) {
        const value = parameters[key];
        if (Array.isArray(value)) {
            if (value.some(entry => hasUnion(entry, depth + 1)))
                return true;
        }
        else if (hasUnion(value, depth + 1))
            return true;
    }
    return false;
}
/** Whether every entry of a `type` list is a known JSON Schema type name. */
export function unknownTypes(parameters, depth = 0, found = []) {
    if (!isNode(parameters) || depth > MAX_DEPTH)
        return found;
    const list = typeList(parameters);
    if (list !== undefined) {
        for (const entry of list) {
            if (typeof entry === 'string' && !TYPE_NAMES.includes(entry) && !found.includes(entry))
                found.push(entry);
        }
    }
    for (const key of [...MAP_SCHEMA_KEYS, ...NODE_SCHEMA_KEYS, ...ARRAY_SCHEMA_KEYS, ...UNION_KEYS, 'allOf']) {
        const value = parameters[key];
        if (Array.isArray(value))
            for (const entry of value)
                unknownTypes(entry, depth + 1, found);
        else
            unknownTypes(value, depth + 1, found);
    }
    return found;
}
