/**
 * Narrow MCP tool parameter schemas to one type per node, at registration.
 *
 * ## The gap
 *
 * A tool parameter declared with a `type` list, an `anyOf` or a `oneOf` is legal
 * JSON Schema, and third-party MCP servers publish them: the source report
 * measured a code-search server declaring `anyOf [array|string, null]` on its
 * main parameters, and read the last request header of 702 sessions (216 distinct
 * tools) to size the problem. A model that reduces a union to its first member —
 * the reported one is Gemini — can then never fill the parameter with the other
 * members, so `["boolean","string"]` is a parameter no caller can send a string
 * to.
 *
 * Our own tools can be corrected at the source. An MCP server's can not:
 * `createMcpToolDefinition(ctx, { inputSchema: tool.inputSchema, ... })` puts the
 * server's schema on the definition unchanged, and `syncTools()` registers that
 * definition as it is (`packages/mcp/mcp-client/src/tools.ts`).
 *
 * ## Where it attaches
 *
 * The tool registry is a cordis service, one instance per context, and the
 * traceable view other callers hold forwards its reads to that instance
 * (`ctx.get('tools')[Symbol.for('cordis.original')]`). A write to the
 * **instance** is therefore seen by every reader — including `mcp-client`, which
 * calls `ctx.tools.register(...)` by name lookup at call time — while a write to
 * the view would be visible only to the writer.
 *
 * The seam is therefore the same one `@argszero/dsh-mcp-tool-filter` uses (that
 * plugin decides *whether* a tool is registered; this one decides *what schema*
 * it is registered with). **Two plugins on one seam must chain**: the wrapper
 * captures the `register` that was installed when *it* mounted and calls that,
 * rather than reading `ctx.tools.register` again — which would be this plugin
 * calling itself. Unmount restores the captured function only when this mount
 * installed it as an own property, so a plugin that mounted earlier keeps its
 * shadow.
 *
 * ## What it deliberately does not do
 *
 * It never talks to a server and never changes what a server lists. It never
 * touches the arguments a call carries: narrowing the schema tells the model what
 * it may send, and the server still validates the call against what it accepts —
 * which is a superset of the narrowed schema. It never mutates the schema it was
 * handed. It never throws into a registration.
 *
 * @module @argszero/dsh-mcp-schema-normalizer
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
import type { NormalizerSnapshot } from './normalizer.ts';
export type { AdditionalPropertiesMode, Config, Mode, ServerRule, Settings } from './config.ts';
export { ADDITIONAL_PROPERTIES_MODES, MODES, SERVER_NAME, TYPE_NAMES, TYPE_PREFERENCE, normalizeConfig, unmatchableReason, } from './config.ts';
export type { Change, NormalizeResult, Rule } from './normalize.ts';
export { MAX_DEPTH, hasUnion, isNullBranch, normalizeSchema, resolveLocalRef, unknownTypes } from './normalize.ts';
export type { ChangeLog, Counters, Coverage, NormalizerSnapshot, Sink, Verdict } from './normalizer.ts';
export { CHANGE_LOG_LIMIT, EVERY_MCP_TOOL, NOT_SELECTED, ToolNormalizer } from './normalizer.ts';
export type { ServerMatch } from './detect.ts';
export { MCP_PREFIX, SERVER_SEPARATOR, isMcpName, matchServer } from './detect.ts';
/** Stable Loader identity. */
export declare const name = "mcp-schema-normalizer";
/** The capability whose `register` this plugin shadows. */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        mcpSchemaNormalizer: McpSchemaNormalizerService;
    }
}
/** The service this plugin provides: the state of the normalizer, and its own reset. */
export interface McpSchemaNormalizerService {
    /** Counters, the schemas narrowed, and what the configuration did not cover, as of now. */
    snapshot(): NormalizerSnapshot;
    /** Zero the counters and the observed sets. The shadow and the configuration stay. */
    reset(): void;
}
/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the defaults live in `apply(ctx, config = {})` and not in an
 * exported `Config`: cordis calls `Config['~standard'].validate` on a plugin's
 * `Config`, and a plain defaults object has no such property, so naming one
 * there makes every mount of the installed package throw before this function
 * runs.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it carries a `Config`. This one
 * carries none — the defaults reach a mount through `apply(ctx, config = {})` —
 * because a `Config` here would have to be a real schema, and a plain defaults
 * object is the defect this family has shipped repeatedly.
 */
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map