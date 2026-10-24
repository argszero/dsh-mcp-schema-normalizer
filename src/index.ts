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

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { normalizeConfig } from './config.ts'
import type { Config } from './config.ts'
import { CHANGE_LOG_LIMIT, ToolNormalizer } from './normalizer.ts'
import type { NormalizerSnapshot } from './normalizer.ts'

export type { AdditionalPropertiesMode, Config, Mode, ServerRule, Settings } from './config.ts'
export {
  ADDITIONAL_PROPERTIES_MODES,
  MODES,
  SERVER_NAME,
  TYPE_NAMES,
  TYPE_PREFERENCE,
  normalizeConfig,
  unmatchableReason,
} from './config.ts'
export type { Change, NormalizeResult, Rule } from './normalize.ts'
export { MAX_DEPTH, hasUnion, isNullBranch, normalizeSchema, resolveLocalRef, unknownTypes } from './normalize.ts'
export type { ChangeLog, Counters, Coverage, NormalizerSnapshot, Sink, Verdict } from './normalizer.ts'
export { CHANGE_LOG_LIMIT, EVERY_MCP_TOOL, NOT_SELECTED, ToolNormalizer } from './normalizer.ts'
export type { ServerMatch } from './detect.ts'
export { MCP_PREFIX, SERVER_SEPARATOR, isMcpName, matchServer } from './detect.ts'

/** Stable Loader identity. */
export const name = 'mcp-schema-normalizer'

/** The capability whose `register` this plugin shadows. */
export const inject = ['tools']

/**
 * The key the vendored traceable proxy stores its target under
 * (`vendor/cordis/src/utils.ts`: `original: Symbol.for('cordis.original')`).
 *
 * Read through `Reflect` rather than declared as an interface member: the value
 * is a foreign object's private protocol, and a `[key: symbol]` index signature
 * would claim a type for something this plugin cannot verify.
 */
const ORIGINAL = Symbol.for('cordis.original')

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpSchemaNormalizer: McpSchemaNormalizerService
  }
}

/** The service this plugin provides: the state of the normalizer, and its own reset. */
export interface McpSchemaNormalizerService {
  /** Counters, the schemas narrowed, and what the configuration did not cover, as of now. */
  snapshot(): NormalizerSnapshot
  /** Zero the counters and the observed sets. The shadow and the configuration stay. */
  reset(): void
}

/** The names currently registered, or an empty list when the registry cannot be read. */
function liveNames(view: ToolRuntime): string[] {
  try {
    return view.schemas().map(schema => schema.name)
  } catch {
    // A registry that cannot enumerate its own surface is not this plugin's
    // failure to report, and the catch-up warning is worth more than a throw
    // during a mount.
    return []
  }
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
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  const normalizer = new ToolNormalizer(settings, settings.mode, {
    info: message => { ctx.logger.info(message) },
    warn: message => { ctx.logger.warn(message) },
  })
  ctx.effect(() => {
    const view = ctx.get('tools')
    if (view === undefined) {
      // `inject` should have held the plugin until the service exists; reaching
      // here means it does not, and a normalizer that cannot be installed must
      // say so rather than report coverage it never observed.
      ctx.logger.warn('mcp-schema-normalizer: the tools service is not available; no schema was narrowed')
      return () => {}
    }
    // The traceable view forwards reads to the instance behind it, and the
    // instance is where a write has to land for every other reader to see it.
    const underlying = (Reflect.get(view as object, ORIGINAL) as ToolRuntime | undefined) ?? view
    // Captured at mount: a second plugin on this seam may already have wrapped
    // it, and that wrapper is what this one has to call.
    const original = underlying.register
    const ownRegister = Object.hasOwn(underlying, 'register')
    let installed = false
    try {
      Reflect.set(underlying, 'register', function (this: ToolRuntime, definition: ToolDefinition): () => void {
        return normalizer.handle(definition, (next: unknown) => original.call(this, next as ToolDefinition))
      })
      installed = true
      normalizer.patched = true
    } catch (error: unknown) {
      // A frozen or sealed provider. Reported, and reported as *not patched*:
      // `patched` is the difference between "nothing needed narrowing" and
      // "nothing could be narrowed".
      normalizer.patched = false
      ctx.logger.warn(`mcp-schema-normalizer: could not shadow register on the tools service: ${String(error)}`)
    }
    if (installed) {
      normalizer.notePreExisting(liveNames(view))
      const late = normalizer.snapshot().coverage.preExisting
      if (late.length > 0) {
        ctx.logger.warn(
          `mcp-schema-normalizer: ${late.length} MCP tool(s) are already registered (${late.slice(0, 5).join(', ')}`
          + `${late.length > 5 ? ', …' : ''}); this row is mounted after the mcp-client row that registered them,`
          + ' and a plugin cannot re-register another plugin\'s tools — list the normalizer first to cover them',
        )
      }
      if (settings.report) {
        ctx.logger.info(`mcp-schema-normalizer: mounted in ${settings.mode} mode — ${normalizer.describeMount()}`)
        if (settings.preferFellBack) {
          ctx.logger.warn('mcp-schema-normalizer: `prefer` named no usable type name and fell back to the default order')
        }
      }
    }
    return () => {
      if (!installed) return
      try {
        if (ownRegister) Reflect.set(underlying, 'register', original)
        else Reflect.deleteProperty(underlying, 'register')
      } catch (error: unknown) {
        ctx.logger.warn(`mcp-schema-normalizer: could not restore the tools service: ${String(error)}`)
      }
      normalizer.patched = false
      if (settings.report) ctx.logger.info(`mcp-schema-normalizer: unmounted — ${normalizer.describeUnmount()}`)
    }
  }, 'mcp-schema-normalizer: narrow MCP tool parameter schemas at registration')
  ctx.provide('mcpSchemaNormalizer', {
    snapshot: () => normalizer.snapshot(),
    reset: () => { normalizer.reset() },
  } satisfies McpSchemaNormalizerService)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it carries a `Config`. This one
 * carries none — the defaults reach a mount through `apply(ctx, config = {})` —
 * because a `Config` here would have to be a real schema, and a plain defaults
 * object is the defect this family has shipped repeatedly.
 */
export default { name, inject, apply }
