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
import { MCP_PREFIX, SERVER_SEPARATOR } from "./detect.js";
/** The modes, as a runtime list so validation and documentation cannot drift. */
export const MODES = ['normalize', 'observe', 'off'];
/** The `serverName` contract `mcp-client` validates before it connects (`[A-Za-z0-9_-]{1,32}`). */
export const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
/** The modes, as a runtime list so validation and documentation cannot drift. */
export const ADDITIONAL_PROPERTIES_MODES = ['drop', 'keep'];
/** The JSON Schema type names a surviving `type` list is reduced from. */
export const TYPE_NAMES = ['string', 'array', 'object', 'number', 'integer', 'boolean', 'null'];
/**
 * The order a surviving `type` list is reduced by, most-preferred first.
 *
 * This is the order the source report ran in production, and its first entry is
 * load-bearing: the reported defect is a parameter declared `["boolean",
 * "string"]` that no model would ever fill with a string, and `string` is the
 * member a caller most often has to be able to send. `integer` sits after
 * `number` so a list carrying both stays a number rather than rejecting 3.5.
 */
export const TYPE_PREFERENCE = ['string', 'array', 'object', 'number', 'integer', 'boolean'];
/** A value's shape, for an error message that has to be actionable without a debugger. */
function describe(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `an array of ${value.length}`;
    return typeof value;
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
export function unmatchableReason(name) {
    if (!SERVER_NAME.test(name)) {
        return `"${name}" is not a valid mcp-client serverName (${SERVER_NAME.source})`;
    }
    return undefined;
}
/** The server names, as the operator wrote them. */
function readServers(servers) {
    if (servers === undefined)
        return [];
    if (!Array.isArray(servers)) {
        // A bare string is the mistake this catches: `servers: github` reads like a
        // one-server selection and would otherwise be an array of characters, i.e. a
        // selection that matches nothing and says nothing.
        throw new TypeError(`mcp-schema-normalizer: servers must be an array of server names, got ${describe(servers)}`);
    }
    const out = [];
    for (const name of servers) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError(`mcp-schema-normalizer: servers must contain non-empty strings, got ${describe(name)}`);
        }
        out.push(name);
    }
    return out;
}
/**
 * The preference order, validated.
 *
 * An unknown name is dropped rather than rejected: `prefer` is a preference
 * among seven known type names, and an operator adding one typo should not lose
 * the five correct entries beside it. A list that keeps **nothing** is the one
 * case that cannot be honoured — it would make every reduction arbitrary — so it
 * falls back to the default and the mount reports that it did.
 * @param prefer - the configured order, or `undefined`.
 * @returns the order to use, and whether it is the default.
 */
function readPrefer(prefer) {
    if (prefer === undefined)
        return { order: [...TYPE_PREFERENCE], fellBack: false };
    if (!Array.isArray(prefer)) {
        throw new TypeError(`mcp-schema-normalizer: prefer must be an array of type names, got ${describe(prefer)}`);
    }
    const order = [];
    for (const entry of prefer) {
        if (typeof entry !== 'string') {
            throw new TypeError(`mcp-schema-normalizer: prefer must contain strings, got ${describe(entry)}`);
        }
        // 'null' is not a preference: a list that reached the preference step has
        // already had its null removed, and admitting it here would let a
        // configuration reinstate the very member this plugin exists to drop.
        if (entry === 'null' || !TYPE_NAMES.includes(entry))
            continue;
        if (!order.includes(entry))
            order.push(entry);
    }
    return order.length === 0 ? { order: [...TYPE_PREFERENCE], fellBack: true } : { order, fellBack: false };
}
/** Whether an optional boolean field is absent or a boolean, and its resolved value. */
function readBoolean(value, field, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean') {
        throw new TypeError(`mcp-schema-normalizer: ${field} must be a boolean, got ${describe(value)}`);
    }
    return value;
}
/**
 * The `additionalProperties` posture, validated.
 *
 * An unrecognised word throws instead of falling back: `keep` and `drop` are
 * opposite repairs for the same provider, and an operator who wrote `remove`
 * would otherwise be told the mount succeeded while the keyword that fails every
 * request stayed in the schema.
 * @param value - the configured value, or `undefined`.
 * @returns the posture to use.
 */
function readAdditionalProperties(value) {
    if (value === undefined)
        return 'drop';
    if (typeof value !== 'string' || !ADDITIONAL_PROPERTIES_MODES.includes(value)) {
        throw new RangeError(`mcp-schema-normalizer: additionalProperties must be one of ${ADDITIONAL_PROPERTIES_MODES.join(', ')}, got ${String(value)}`);
    }
    return value;
}
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
export function normalizeConfig(config = {}) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new TypeError(`mcp-schema-normalizer: config must be an object, got ${describe(config)}`);
    }
    const mode = config.mode ?? 'normalize';
    if (!MODES.includes(mode)) {
        throw new RangeError(`mcp-schema-normalizer: mode must be one of ${MODES.join(', ')}, got ${String(mode)}`);
    }
    const prefer = readPrefer(config.prefer);
    return {
        mode,
        servers: readServers(config.servers).map(name => {
            const reason = unmatchableReason(name);
            return reason === undefined
                ? { name, prefix: `${MCP_PREFIX}${name}${SERVER_SEPARATOR}` }
                : { name, prefix: undefined, unmatchableReason: reason };
        }),
        prefer: prefer.order,
        preferFellBack: prefer.fellBack,
        nullBranches: readBoolean(config.nullBranches, 'nullBranches', true),
        mergeObjectBranches: readBoolean(config.mergeObjectBranches, 'mergeObjectBranches', true),
        inlineRefs: readBoolean(config.inlineRefs, 'inlineRefs', true),
        additionalProperties: readAdditionalProperties(config.additionalProperties),
        report: readBoolean(config.report, 'report', true),
    };
}
