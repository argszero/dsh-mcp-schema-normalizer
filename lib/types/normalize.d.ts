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
import type { Settings } from './config.ts';
/** A JSON Schema node, as it arrives from a server: unvalidated and possibly malformed. */
type Node = Record<string, unknown>;
/** The rule that changed one node. */
export type Rule = 
/** A `type` list lost `"null"` and kept exactly one of the survivors. */
'narrow-type-list'
/** An `anyOf`/`oneOf` lost its null-only branches. */
 | 'drop-null-branch'
/** An `anyOf`/`oneOf` lost every branch and was removed from the node. */
 | 'drop-empty-union'
/** An `anyOf`/`oneOf` of objects became a single object node. */
 | 'merge-object-branches'
/** A local `$ref` was replaced by the subschema it points at. */
 | 'inline-ref'
/** A `$defs`/`definitions` table nothing points into any more was removed. */
 | 'prune-defs'
/** An `additionalProperties` keyword was removed from the declaration. */
 | 'drop-additional-properties';
/** One keyword that changed, and what it was. */
export interface Change {
    /** Where in the schema, as a JSON-pointer-ish path rooted at `#`. */
    readonly path: string;
    readonly rule: Rule;
    /** The keyword's value before the change. */
    readonly before: unknown;
    /** The keyword's value after the change. */
    readonly after: unknown;
}
/** The narrowed schema and the account of what was narrowed. */
export interface NormalizeResult {
    /** The schema to register. A fresh object graph; the input is untouched. */
    readonly schema: Node;
    readonly changes: readonly Change[];
    /**
     * The `$ref` values this pass left in place, deduplicated, in first-seen order:
     * external URLs, dangling pointers and cycles. A schema listed here is one the
     * plugin could not repair on this deployment — the same reading `unknownTypes`
     * gives for a `type` list.
     */
    readonly unresolvedRefs: readonly string[];
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
export declare function isNullBranch(branch: unknown): boolean;
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
export declare function resolveLocalRef(root: Node, ref: string): unknown;
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
export declare function collectRefs(node: unknown, depth?: number, found?: string[], outsideDefinitions?: boolean): string[];
/** How many references one schema may expand before the rest are left in place. */
export declare const MAX_REF_EXPANSIONS = 512;
/** The depth past which a schema is registered unchanged rather than walked further. */
export declare const MAX_DEPTH = 32;
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
export declare function normalizeSchema(parameters: unknown, settings: Settings): NormalizeResult | undefined;
/** Whether a schema contains anything this plugin knows how to narrow. */
export declare function hasUnion(parameters: unknown, depth?: number): boolean;
/** Whether every entry of a `type` list is a known JSON Schema type name. */
export declare function unknownTypes(parameters: unknown, depth?: number, found?: string[]): string[];
export {};
//# sourceMappingURL=normalize.d.ts.map