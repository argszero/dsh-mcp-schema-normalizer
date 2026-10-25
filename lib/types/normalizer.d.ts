/**
 * The registration-path decision: narrow this definition's `parameters`, or
 * forward it untouched — and the account of every time it chose either.
 *
 * Kept apart from the mount (`src/index.ts`) so the decision can be exercised
 * without a shadow, and so the counters have one owner.
 *
 * @module @argszero/dsh-mcp-schema-normalizer/normalizer
 */
import type { Mode, Settings } from './config.ts';
import type { Change, Rule } from './normalize.ts';
/** Why a registration was forwarded without its schema being narrowed. */
export type Verdict = 
/** Not a name this plugin selects (not `mcp__*`, or not a configured server). */
'notSelected'
/** Selected, but the definition carried no readable `parameters` object. */
 | 'unreadable'
/** Selected and readable, but nothing in it matched a rule. */
 | 'unchanged'
/** Selected and narrowed — registered narrowed in `normalize`, as it arrived in `observe`. */
 | 'narrowed'
/** Narrowing threw; the server's own definition was forwarded instead. */
 | 'failed';
/** One registration that was changed (or would have been, in `observe` mode). */
export interface ChangeLog {
    /** The public tool name the registration carried. */
    readonly tool: string;
    /** The server the name was attributed to, or `undefined` when every server is selected. */
    readonly server: string | undefined;
    /** Which rules fired, and where. */
    readonly changes: readonly Change[];
    /** Whether the narrowed schema was the one registered. */
    readonly applied: boolean;
}
/** How far the configuration reached. */
export interface Coverage {
    /**
     * MCP tool names already in the registry when the shadow was installed.
     *
     * Non-empty means this row is mounted after the `mcp-client` row that
     * registered them: a plugin cannot re-register another plugin's tools, so those
     * schemas keep whatever the server sent. It is reported instead of being left
     * mysterious.
     */
    readonly preExisting: readonly string[];
    /** One entry per configured server, with how many registrations it matched. */
    readonly servers: readonly {
        readonly name: string;
        readonly matched: number;
        readonly unmatchableReason?: string;
    }[];
    /** Whether the deployment limited selection at all (false = every `mcp__*` tool). */
    readonly serverLimited: boolean;
}
/** Counters, for a deployment that wants the numbers rather than the log. */
export interface Counters {
    /** Registrations that arrived while the shadow was installed. */
    readonly seen: number;
    readonly notSelected: number;
    readonly unreadable: number;
    readonly unchanged: number;
    readonly narrowed: number;
    readonly failed: number;
    /** Individual keyword changes, summed over every narrowed registration. */
    readonly changes: number;
    /** Registrations that carried a union-shaped schema which no rule matched. */
    readonly unionButUnchanged: number;
}
/** The service this plugin provides. */
export interface NormalizerSnapshot {
    /** Whether the shadow is currently installed on the registry instance. */
    readonly patched: boolean;
    readonly mode: Mode;
    readonly counters: Counters;
    readonly rules: Readonly<Record<Rule, number>>;
    /** The first {@link CHANGE_LOG_LIMIT} narrowed registrations, in arrival order. */
    readonly changes: readonly ChangeLog[];
    /** How many narrowed registrations the bounded log could not keep. */
    readonly changesDropped: number;
    readonly coverage: Coverage;
    /** Type names seen in a `type` list that are not JSON Schema types. */
    readonly unknownTypes: readonly string[];
    /**
     * `$ref` values this plugin could not follow — external URLs, dangling
     * pointers, cycles — in first-seen order. A non-empty list says the declaration
     * still carries a reference the reported provider rejects, and names it.
     */
    readonly unresolvedRefs: readonly string[];
    /** Whether a configured `prefer` order was discarded for naming no usable type. */
    readonly preferFellBack: boolean;
}
/** How many change entries the snapshot keeps before it starts counting drops. */
export declare const CHANGE_LOG_LIMIT = 50;
/** Where the mount's own lines go. */
export interface Sink {
    info(message: string): void;
    warn(message: string): void;
}
/**
 * The decision, the counters and the snapshot.
 *
 * Every path through {@link handle} either calls the registration it was given
 * or does not; none of them can throw into a registration, because a normalizer
 * that breaks a mount is worse than the schema it came to repair.
 */
export declare class ToolNormalizer {
    private readonly settings;
    private readonly mode;
    private readonly sink;
    /** Whether the shadow is installed. Set by the mount; read by the snapshot. */
    patched: boolean;
    private readonly counts;
    private seen;
    private changeTotal;
    private ruleCounts;
    private log;
    private dropped;
    private readonly perServer;
    private preExisting;
    private readonly unknownTypeNames;
    private readonly unresolvedRefs;
    private unionUnchanged;
    private reported;
    /**
     * @param settings - the validated configuration.
     * @param mode - the mode. Kept beside the settings rather than read from them
     * so the one decision it changes cannot be confused with the config shape.
     * @param sink - where the first-change, summary and unmount lines go.
     */
    constructor(settings: Settings, mode: Mode, sink: Sink);
    /**
     * Decide one registration.
     *
     * `register` is the call that performs the registration — either the raw
     * service method with the definition to use, or a thunk that closes over it.
     * Passing the definition in and getting the call back keeps this class free of
     * the registry's types without letting the name and the parameters come from
     * two different registrations.
     * @param definition - the definition the registration carried.
     * @param register - performs the registration with the definition to use.
     * @returns whatever `register` returned.
     */
    handle<T>(definition: unknown, register: (definition: unknown) => T): T;
    /**
     * Record the MCP tool names already in the registry when the shadow went in.
     * @param names - the names the registry reported.
     */
    notePreExisting(names: readonly string[]): void;
    /** Zero the counters and the log. The shadow and the configuration stay. */
    reset(): void;
    /** The current state, as a plain object. */
    snapshot(): NormalizerSnapshot;
    /** The one-line mount summary. */
    describeMount(): string;
    /** The unmount summary: what the mount did, in the deployment's own numbers. */
    describeUnmount(): string;
    /**
     * Run the narrowing, containing a throw.
     *
     * A schema a server published is data from outside this process; a rule that
     * cannot read one part of it must not cost the registration.
     * @param name - the tool name, for the warning.
     * @param parameters - the schema.
     * @returns the result, or `undefined` when narrowing threw or could not read it.
     */
    private narrow;
    /**
     * Which server's registrations this name belongs to.
     *
     * Selection is "is this an MCP tool" when the deployment named no servers, and
     * "is this one of the named servers" when it did. The two returns below are
     * distinguished by identity rather than by a wrapper object so the common path
     * allocates nothing.
     * @param name - the public tool name.
     * @returns the server key, {@link EVERY_MCP_TOOL}, or {@link NOT_SELECTED}.
     */
    private attribute;
    /** The first-change line, once per mount, so a report flag is not a firehose. */
    private report;
}
/** Returned by {@link ToolNormalizer.attribute} when the deployment named no servers. */
export declare const EVERY_MCP_TOOL = "\0every";
/** Returned by {@link ToolNormalizer.attribute} when no configured server owns the name. */
export declare const NOT_SELECTED = "\0none";
//# sourceMappingURL=normalizer.d.ts.map