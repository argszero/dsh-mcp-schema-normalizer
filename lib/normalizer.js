/**
 * The registration-path decision: narrow this definition's `parameters`, or
 * forward it untouched — and the account of every time it chose either.
 *
 * Kept apart from the mount (`src/index.ts`) so the decision can be exercised
 * without a shadow, and so the counters have one owner.
 *
 * @module @argszero/dsh-mcp-schema-normalizer/normalizer
 */
import { matchServer } from "./detect.js";
import { hasUnion, normalizeSchema, unknownTypes } from "./normalize.js";
/** How many change entries the snapshot keeps before it starts counting drops. */
export const CHANGE_LOG_LIMIT = 50;
/** The rules, as a runtime list so the counter object cannot drift from the type. */
const RULES = [
    'narrow-type-list',
    'drop-null-branch',
    'drop-empty-union',
    'merge-object-branches',
    'inline-ref',
    'prune-defs',
    'drop-additional-properties',
];
/** The `parameters` of a definition, when it has one. */
function parametersOf(definition) {
    if (typeof definition !== 'object' || definition === null)
        return undefined;
    return definition.parameters;
}
/** The `name` of a definition, when it has one. */
function nameOf(definition) {
    if (typeof definition !== 'object' || definition === null)
        return undefined;
    return definition.name;
}
/** A fresh zeroed rule counter. */
function emptyRules() {
    const out = {};
    for (const rule of RULES)
        out[rule] = 0;
    return out;
}
/** A change list as one line, for the first-change report. */
function describeChanges(changes) {
    const byRule = new Map();
    for (const change of changes)
        byRule.set(change.rule, (byRule.get(change.rule) ?? 0) + 1);
    return [...byRule].map(([rule, count]) => `${rule} x${count}`).join(', ');
}
/**
 * The decision, the counters and the snapshot.
 *
 * Every path through {@link handle} either calls the registration it was given
 * or does not; none of them can throw into a registration, because a normalizer
 * that breaks a mount is worse than the schema it came to repair.
 */
export class ToolNormalizer {
    settings;
    mode;
    sink;
    /** Whether the shadow is installed. Set by the mount; read by the snapshot. */
    patched = false;
    counts = {
        notSelected: 0,
        unreadable: 0,
        unchanged: 0,
        narrowed: 0,
        failed: 0,
    };
    seen = 0;
    changeTotal = 0;
    ruleCounts = emptyRules();
    log = [];
    dropped = 0;
    perServer = new Map();
    preExisting = [];
    unknownTypeNames = [];
    unresolvedRefs = [];
    unionUnchanged = 0;
    reported = false;
    /**
     * @param settings - the validated configuration.
     * @param mode - the mode. Kept beside the settings rather than read from them
     * so the one decision it changes cannot be confused with the config shape.
     * @param sink - where the first-change, summary and unmount lines go.
     */
    constructor(settings, mode, sink) {
        this.settings = settings;
        this.mode = mode;
        this.sink = sink;
    }
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
    handle(definition, register) {
        this.seen += 1;
        const name = nameOf(definition);
        if (typeof name !== 'string') {
            // A registration with no readable name cannot be attributed to a server,
            // so it is forwarded rather than guessed at.
            this.counts.notSelected += 1;
            return register(definition);
        }
        const server = this.attribute(name);
        if (server === NOT_SELECTED) {
            this.counts.notSelected += 1;
            return register(definition);
        }
        const parameters = parametersOf(definition);
        if (parameters === undefined) {
            this.counts.unreadable += 1;
            this.report(name, 'unreadable');
            return register(definition);
        }
        const result = this.narrow(name, parameters);
        if (result === undefined) {
            this.counts.unreadable += 1;
            this.report(name, 'unreadable');
            return register(definition);
        }
        for (const entry of unknownTypes(parameters)) {
            if (!this.unknownTypeNames.includes(entry))
                this.unknownTypeNames.push(entry);
        }
        for (const entry of result.unresolvedRefs) {
            if (!this.unresolvedRefs.includes(entry))
                this.unresolvedRefs.push(entry);
        }
        if (result.changes.length === 0) {
            this.counts.unchanged += 1;
            if (hasUnion(parameters))
                this.unionUnchanged += 1;
            return register(definition);
        }
        this.counts.narrowed += 1;
        this.changeTotal += result.changes.length;
        for (const change of result.changes)
            this.ruleCounts[change.rule] += 1;
        const applied = this.mode === 'normalize';
        if (this.log.length < CHANGE_LOG_LIMIT) {
            this.log.push({ tool: name, server: server === EVERY_MCP_TOOL ? undefined : server, changes: result.changes, applied });
        }
        else
            this.dropped += 1;
        this.report(name, 'narrowed', result.changes);
        if (!applied)
            return register(definition);
        return register({ ...definition, parameters: result.schema });
    }
    /**
     * Record the MCP tool names already in the registry when the shadow went in.
     * @param names - the names the registry reported.
     */
    notePreExisting(names) {
        this.preExisting = names.filter(name => name.startsWith('mcp__'));
    }
    /** Zero the counters and the log. The shadow and the configuration stay. */
    reset() {
        for (const verdict of Object.keys(this.counts))
            this.counts[verdict] = 0;
        this.seen = 0;
        this.changeTotal = 0;
        this.ruleCounts = emptyRules();
        this.log = [];
        this.dropped = 0;
        this.unionUnchanged = 0;
        this.unknownTypeNames.length = 0;
        this.unresolvedRefs.length = 0;
        for (const key of this.perServer.keys())
            this.perServer.set(key, 0);
    }
    /** The current state, as a plain object. */
    snapshot() {
        return {
            patched: this.patched,
            mode: this.mode,
            counters: {
                seen: this.seen,
                notSelected: this.counts.notSelected,
                unreadable: this.counts.unreadable,
                unchanged: this.counts.unchanged,
                narrowed: this.counts.narrowed,
                failed: this.counts.failed,
                changes: this.changeTotal,
                unionButUnchanged: this.unionUnchanged,
            },
            rules: { ...this.ruleCounts },
            changes: [...this.log],
            changesDropped: this.dropped,
            coverage: {
                preExisting: [...this.preExisting],
                servers: this.settings.servers.map(rule => ({
                    name: rule.name,
                    matched: this.perServer.get(rule.name) ?? 0,
                    ...(rule.unmatchableReason === undefined ? {} : { unmatchableReason: rule.unmatchableReason }),
                })),
                serverLimited: this.settings.servers.length > 0,
            },
            unknownTypes: [...this.unknownTypeNames],
            unresolvedRefs: [...this.unresolvedRefs],
            preferFellBack: this.settings.preferFellBack,
        };
    }
    /** The one-line mount summary. */
    describeMount() {
        const basis = this.settings.servers.length === 0
            ? 'every mcp__* tool'
            : `${this.settings.servers.length} configured server(s)`;
        const rules = [
            this.settings.nullBranches ? 'null members dropped' : 'null members kept',
            this.settings.mergeObjectBranches ? 'object unions merged' : 'object unions kept',
            this.settings.inlineRefs ? 'local $refs inlined' : 'local $refs kept',
            this.settings.additionalProperties === 'drop' ? 'additionalProperties dropped' : 'additionalProperties kept',
        ];
        return `selecting ${basis}; ${rules.join(', ')}; preference ${this.settings.prefer.join(' > ')}`;
    }
    /** The unmount summary: what the mount did, in the deployment's own numbers. */
    describeUnmount() {
        const counts = this.counts;
        return `${counts.narrowed} narrowed (${this.changeTotal} keyword change(s)), ${counts.unchanged} unchanged, `
            + `${counts.unreadable} unreadable, ${counts.notSelected} not selected, ${counts.failed} failed`;
    }
    /**
     * Run the narrowing, containing a throw.
     *
     * A schema a server published is data from outside this process; a rule that
     * cannot read one part of it must not cost the registration.
     * @param name - the tool name, for the warning.
     * @param parameters - the schema.
     * @returns the result, or `undefined` when narrowing threw or could not read it.
     */
    narrow(name, parameters) {
        try {
            return normalizeSchema(parameters, this.settings);
        }
        catch (error) {
            this.counts.failed += 1;
            this.sink.warn(`mcp-schema-normalizer: narrowing ${name} threw; its schema was registered unchanged: ${String(error)}`);
            return undefined;
        }
    }
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
    attribute(name) {
        if (!name.startsWith('mcp__'))
            return NOT_SELECTED;
        if (this.settings.servers.length === 0)
            return EVERY_MCP_TOOL;
        const match = matchServer(name, this.settings.servers);
        if (match === undefined)
            return NOT_SELECTED;
        this.perServer.set(match.server, (this.perServer.get(match.server) ?? 0) + 1);
        return match.server;
    }
    /** The first-change line, once per mount, so a report flag is not a firehose. */
    report(name, verdict, changes = []) {
        if (!this.settings.report || this.reported)
            return;
        this.reported = true;
        if (verdict === 'narrowed') {
            const first = changes[0];
            this.sink.info(`mcp-schema-normalizer: first narrowed schema is ${name} — ${describeChanges(changes)}`
                + (first === undefined ? '' : ` (e.g. ${first.path}: ${String(first.before)} -> ${String(first.after)})`));
        }
        else {
            this.sink.info(`mcp-schema-normalizer: ${name} is selected but carries no readable parameters object`);
        }
    }
}
/** Returned by {@link ToolNormalizer.attribute} when the deployment named no servers. */
export const EVERY_MCP_TOOL = '\u0000every';
/** Returned by {@link ToolNormalizer.attribute} when no configured server owns the name. */
export const NOT_SELECTED = '\u0000none';
