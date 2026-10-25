/**
 * What a loader entry may ask the normalizer for, and what it refuses to guess.
 *
 * Every field is optional and every default lives in {@link normalizeConfig}.
 * The defaults are *not* exported as a `Config` on the plugin's default export:
 * cordis calls `Config['~standard'].validate` on a plugin's `Config`, a plain
 * defaults object has no such property, and naming one there makes every mount
 * of the installed package throw `reading 'validate'` before `apply` runs — the
 * defect this ecosystem has shipped more than once. A `Config` therefore has to
 * be a real schema or absent, and this plugin chooses absent.
 *
 * @module @argszero/dsh-mcp-schema-normalizer/config
 */
/** What the plugin does with a schema it selected for narrowing. */
export type Mode = 
/**
 * Replace `definition.parameters` with the narrowed schema before the
 * registration is forwarded. The default: the gap is that a union-typed
 * parameter cannot be filled by a model that reads a type list as its first
 * entry, and a mitigation an operator has to arm twice is a mitigation that is
 * off in the deployments that need it.
 */
'normalize'
/**
 * Register the server's schema untouched and report what `normalize` would
 * have changed — the posture to mount first, because it answers "what would
 * this do on *this* deployment's servers?" with the deployment's own schemas
 * rather than the README's example.
 */
 | 'observe'
/** Mount nothing at all: no shadow, no service, no counters. */
 | 'off';
/** The modes, as a runtime list so validation and documentation cannot drift. */
export declare const MODES: readonly Mode[];
/** The `serverName` contract `mcp-client` validates before it connects (`[A-Za-z0-9_-]{1,32}`). */
export declare const SERVER_NAME: RegExp;
/**
 * What the plugin does with an `additionalProperties` keyword in a schema it
 * selects.
 *
 * Gemini rejects the keyword outright in a tool declaration
 * (`functionDeclarations[].parameters`): one `additionalProperties: false` fails
 * the whole request with HTTP 400 `INVALID_ARGUMENT` before any tool is called, so
 * on that provider a server that closes its objects makes every turn of the
 * session fail. Dropping the keyword is the only repair available to a plugin:
 * the declaration is advisory, and nothing in this process validates a call
 * against it (a raw `ToolDefinition` carries no validator — `defineTool` closes
 * its own validation inside `execute`, and an MCP definition built by
 * `createMcpToolDefinition` has none, so the server remains the only authority on
 * what a call may carry).
 */
export type AdditionalPropertiesMode = 'drop' | 'keep';
/** The modes, as a runtime list so validation and documentation cannot drift. */
export declare const ADDITIONAL_PROPERTIES_MODES: readonly AdditionalPropertiesMode[];
/** The JSON Schema type names a surviving `type` list is reduced from. */
export declare const TYPE_NAMES: readonly string[];
/**
 * The order a surviving `type` list is reduced by, most-preferred first.
 *
 * This is the order the source report ran in production, and its first entry is
 * load-bearing: the reported defect is a parameter declared `["boolean",
 * "string"]` that no model would ever fill with a string, and `string` is the
 * member a caller most often has to be able to send. `integer` sits after
 * `number` so a list carrying both stays a number rather than rejecting 3.5.
 */
export declare const TYPE_PREFERENCE: readonly string[];
/** The configuration a loader entry may pass. Every field is optional. */
export interface Config {
    /** What to do with a selected schema; see {@link Mode}. */
    mode?: Mode;
    /**
     * The `mcp-client` `serverName`s to narrow.
     *
     * **Omitted or empty means every `mcp__*` tool** — the opposite default from
     * the neighbouring `dsh-mcp-tool-filter`, and deliberately so: that plugin's
     * restricted resource is a deployment's own tool budget, while the defect this
     * one repairs is in *third-party* schemas the deployment never wrote. A
     * normalizer an operator has to name every server for is a normalizer that
     * repairs nothing on the servers they did not think of.
     *
     * A named server that never appears is reported in the coverage snapshot
     * rather than treated as an error: which servers connect is discovered at run
     * time from something this plugin never talks to.
     */
    servers?: readonly string[];
    /**
     * The preference order a surviving `type` list is reduced by. Defaults to
     * {@link TYPE_PREFERENCE}. Names outside the JSON Schema type vocabulary are
     * ignored rather than honoured, so a typo cannot make a list reduce to a type
     * no validator knows.
     */
    prefer?: readonly string[];
    /**
     * Whether a `type` list that contains `"null"` loses it. Default true — the
     * whole point is one type per node, and every rule for choosing among the
     * survivors has to answer "and what about null?" first.
     */
    nullBranches?: boolean;
    /**
     * Whether an `anyOf`/`oneOf` whose remaining branches are all objects is
     * merged into a single object node. Default true. The merge keeps `type`,
     * the union of `properties`, the intersection of `required`, and
     * `additionalProperties` only when every branch agreed on it; anything else a
     * branch carried is dropped, which *loosens* the node — see the README's
     * honesty section, and the per-node change report, which shows it.
     */
    mergeObjectBranches?: boolean;
    /**
     * Whether a local `$ref` (`#/$defs/Name`, `#/definitions/Name`, any `#`-rooted
     * pointer) is replaced by the subschema it points at, and a `$defs` table that
     * nothing points into any more is removed. Default true.
     *
     * Gemini reads a `$ref` in a tool declaration as a reference it cannot follow
     * and fails the request, so a server that factors its schema through `$defs`
     * makes every turn of the session fail on that provider. Inlining is
     * semantics-preserving for the declaration — the model is told exactly what the
     * pointer pointed at — and it is bounded: an external URL, a dangling pointer
     * and a cycle are each left as the server wrote it and listed in the snapshot's
     * `unresolvedRefs` rather than resolved on a guess.
     */
    inlineRefs?: boolean;
    /**
     * What to do with an `additionalProperties` keyword; see
     * {@link AdditionalPropertiesMode}. Default `drop`.
     */
    additionalProperties?: AdditionalPropertiesMode;
    /** Whether the mount, first-change and unmount summaries are logged. Default true. */
    report?: boolean;
}
/** One configured server, with the public-name prefix it is matched by. */
export interface ServerRule {
    /** The key exactly as the operator wrote it. */
    readonly name: string;
    /**
     * The public-name prefix this rule matches, or `undefined` when no public
     * name can ever carry it — see {@link unmatchableReason}.
     */
    readonly prefix: string | undefined;
    /** Why {@link prefix} is `undefined`; present only when it is. */
    readonly unmatchableReason?: string;
}
/** The validated configuration, with every default resolved. */
export interface Settings {
    readonly mode: Mode;
    /** The rules, in the order the operator wrote them. Empty means "every MCP tool". */
    readonly servers: readonly ServerRule[];
    /** The resolved type preference order. */
    readonly prefer: readonly string[];
    /** Whether a configured `prefer` was discarded for naming no usable type. */
    readonly preferFellBack: boolean;
    readonly nullBranches: boolean;
    readonly mergeObjectBranches: boolean;
    readonly inlineRefs: boolean;
    readonly additionalProperties: AdditionalPropertiesMode;
    readonly report: boolean;
}
/**
 * Why a configured key can never match, or `undefined` when it can.
 *
 * `mcp-client` validates `serverName` against `[A-Za-z0-9_-]{1,32}` before it
 * connects, so a key outside that shape cannot name a live server on the line
 * this plugin targets. It is still accepted — a configuration may be carried
 * across lines — but it will never match, and the coverage report says so rather
 * than leaving it as a rule that quietly narrows nothing.
 * @param name - the configured server key.
 * @returns the reason, or `undefined`.
 */
export declare function unmatchableReason(name: string): string | undefined;
/**
 * Turn a loader entry's configuration into validated settings.
 *
 * Invalid values throw, which fails the mount: a normalizer whose configuration
 * was silently replaced by a default is a normalizer that reports success while
 * doing something else, and the operator who wrote the typo is the one person
 * who cannot see it.
 * @param config - whatever the loader entry passed, or `undefined` for nothing.
 * @returns the settings, with defaults resolved.
 */
export declare function normalizeConfig(config?: Config): Settings;
//# sourceMappingURL=config.d.ts.map