# @argszero/dsh-mcp-schema-normalizer

A DeepSeek Harness plugin that narrows **union-typed MCP tool parameter schemas**
to one type per node, at registration, before the model ever sees them.

---

## The gap

A tool parameter may legally be declared with a `type` list, an `anyOf` or a
`oneOf`:

```json
{
  "type": "object",
  "properties": {
    "query": { "anyOf": [ { "type": "array", "items": { "type": "string" } },
                          { "type": "string" },
                          { "type": "null" } ] },
    "regex": { "type": ["boolean", "string"] }
  }
}
```

Third-party MCP servers publish exactly this. The upstream report measured a
code-search server doing it on its main parameters and read the last request
header of 702 sessions (216 distinct tools) to size the problem — and the model
in that deployment was Gemini.

**A model that reduces a union to its first member cannot fill the parameter
with the others.** `["boolean","string"]` becomes a parameter that is a boolean
and nothing else: no caller can send a string to it, no matter how plainly the
call needs one.

Our own tools are ours to correct at the source. An MCP server's `inputSchema`
is not:

```ts
// packages/mcp/mcp-client/src/tools.ts — the server's schema goes onto the
// definition uncompiled, and syncTools() registers that definition as it is.
return createMcpToolDefinition(ctx, { inputSchema: tool.inputSchema, ... })
```

## What this plugin does

It shadows `register` on the **tools service instance** — the one seam that a
caller reaching the registry by name lookup (`ctx.tools.register(...)`) passes
through — and rewrites a selected definition's `parameters` before forwarding the
registration. Every reader of the registry, the model included, then sees the
narrowed schema.

The union rules, taken from the report's out-of-tree patch:

| rule | what happens |
|---|---|
| `narrow-type-list` | A `type` list loses `"null"`. One survivor becomes the node's `type`; several survivors are reduced by the preference order (`string`, `array`, `object`, `number`, `integer`, `boolean`). |
| `drop-null-branch` | An `anyOf`/`oneOf` loses its null-only branches. |
| `drop-empty-union` | A union with nothing left is removed from the node, so the node accepts what its other keywords allow instead of accepting nothing. |
| `merge-object-branches` | A union whose remaining branches are *all* objects becomes one object node: the union of `properties`, the intersection of `required`. |

The rules added in **0.2.0**, for the same provider's second and third rejection
(`$ref`/`$defs`, and `additionalProperties`, each fail a whole request before any
tool is called):

| rule | what happens |
|---|---|
| `inline-ref` | A local `$ref` (`#/a/b`, `#/$defs/Name`, `#/definitions/Name`) is replaced by the subschema it points at. A keyword written beside `$ref` overrides the target. |
| `prune-defs` | A `$defs`/`definitions` table that nothing outside it points into any more is removed: its declarations now sit where they are used, and the reported provider rejects the keyword itself. |
| `drop-additional-properties` | The `additionalProperties` keyword is removed from the declaration, whichever shape it had. |

**The arguments sent to the server are never touched.** Narrowing the schema
tells the model what it may send; the server still validates the call against
what it accepts, which is a superset of the narrowed schema.

That is also why inlining a `$ref` is safe rather than a reinterpretation. A
`ToolDefinition` carries no validator: `defineTool` closes validation inside the
tool's own `execute`, and an MCP tool definition built from a server's
`inputSchema` carries none at all, so **the MCP server validates its own
arguments**. The declaration this plugin rewrites is read by exactly one party —
the model — and an inlined `$ref` says the same thing to that reader as the
reference did.

**Two rules the report's patch also carries are not implemented here**, and the
difference is deliberate rather than an oversight:

- *It picks one branch when a union is **not** all objects* (`anyOf: [{type:
  "string"}, {type: "number"}]` becomes `string`). This plugin leaves such a
  union alone and counts it as `counters.unionButUnchanged` instead. Picking
  discards an alternative the server still accepts, so a model that needed the
  number can no longer send one — a deployment whose schemas have such unions can
  weigh that, and this plugin does not weigh it for them.
- *It drops `null` from `enum`.* This plugin leaves `enum` untouched: a
  `type`-list or union null is structural, while an `enum` member is a value the
  server enumerated, and the report's own example does not need it.

## Install

```sh
dsh plugin --profile <name> add @argszero/dsh-mcp-schema-normalizer
```

The package declares `dsh.bundle`, so `dsh` also appends it to
`dsh.profile.bundles` and the row activates on the next boot. **List the
normalizer before the row that connects your MCP servers** — a row mounted after
`mcp-client` cannot re-register tools another plugin already registered, and the
mount will say so (see *Honesty* below).

## Configure

```yaml
- insert:
    - id: mcp-schema-normalizer
      name: '@argszero/dsh-mcp-schema-normalizer'
      config:
        mode: normalize          # normalize | observe | off
        servers: [github]        # omit for every mcp__* tool
        prefer: [string, array, object, number, integer, boolean]
        nullBranches: true
        mergeObjectBranches: true
        inlineRefs: true
        additionalProperties: drop   # drop | keep
        report: true
```

- **`mode`** — `normalize` (default) rewrites a selected schema before it is
  registered. `observe` registers the server's own schema untouched and reports
  what `normalize` *would* have changed; mount this first, because it answers
  "what would this do on *this* deployment's servers?" with your servers rather
  than this README's example. `off` mounts nothing: no shadow, no service, no
  counters.
- **`servers`** — the `mcp-client` `serverName`s to narrow. **Omitted or empty
  means every `mcp__*` tool**, deliberately the opposite default from the
  neighbouring `@argszero/dsh-mcp-tool-filter`: that plugin restricts a
  deployment's *own* tool budget, while the defect this one repairs lives in
  *third-party* schemas the deployment never wrote. A name that never appears is
  reported in the snapshot's coverage rather than treated as an error — which
  servers connect is discovered at run time, from something this plugin never
  talks to.
- **`prefer`** — the order a surviving `type` list is reduced by. Names outside
  the JSON Schema vocabulary are ignored, not honoured, so a typo cannot make a
  list reduce to a type no validator knows; the fallback is reported.
- **`nullBranches`**, **`mergeObjectBranches`** — each rule's off switch.
- **`inlineRefs`** — whether a local `$ref` is replaced by the subschema it points
  at, and a table nothing points into is pruned. Default `true`. An external URL,
  a dangling pointer and a cycle are each left exactly as the server wrote it and
  named in `snapshot().unresolvedRefs`; the pass is bounded by a depth limit and
  by an expansion budget, so a schema that references itself cannot blow up the
  registration.
- **`additionalProperties`** — `drop` (default) or `keep`. On the reported
  provider one `additionalProperties` keyword in a tool declaration fails every
  request with HTTP 400 `INVALID_ARGUMENT`, so a server that closes its objects
  makes the session unusable; dropping it is the only repair a plugin can make.
  `keep` exists for a deployment whose provider accepts the keyword and whose
  models are better served by knowing the object is closed.

## The snapshot

The plugin provides a `mcpSchemaNormalizer` service:

```ts
ctx.mcpSchemaNormalizer.snapshot()
// { patched, mode, counters, rules, changes, coverage }
ctx.mcpSchemaNormalizer.reset()
```

- `counters` — `seen`, `narrowed`, `unchanged`, `unreadable`, `notSelected`,
  `failed`, `changes`, `unionButUnchanged`. The last one is worth watching: it
  counts registrations that carried a union-shaped schema **which no rule
  matched** — a shape the deployment has but the rule set does not cover.
- `rules` — how many times each rule fired (seven in 0.2.0).
- `unresolvedRefs` — every `$ref` the registered declaration still carries:
  external URLs, dangling pointers, cycles, and everything past the expansion
  budget. Non-empty means a declaration this plugin could not repair, named.
- `changes` — the first 50 narrowed registrations, each with its tool name, the
  server it was attributed to, and the per-node changes.
- `coverage.serverLimited` — whether `servers` narrowed anything at all.

## Honesty

Read this before switching it on.

- **`mergeObjectBranches` loosens the node.** The merge keeps a branch's
  `properties` union and `required` intersection, and keeps
  `additionalProperties` only when every branch agreed on it. Anything else a
  branch carried — `patternProperties`, `unevaluatedProperties`, a nested
  `not` — is dropped, and a dropped restriction is a schema that admits *more*
  than the server's. The per-node change report shows every merge, so `observe`
  mode answers this on your own servers before it is armed.
- **Narrowing `["boolean","string"]` to `string` makes a boolean invalid** where
  the server would have accepted it. That is the trade the report's deployment
  made, and it is why the preference order is configurable rather than fixed.
- **A tool registered before the mount is not covered.** The mount lists those
  tools in `coverage.preExisting` and warns with the count. A plugin cannot
  re-register another plugin's tools; list the normalizer first.
- **It rewrites what the model is *told*, not what the server accepts.** If a
  model fills a narrowed field with a value the server rejects, the server's
  validation is still the authority.
- **It never throws into a registration.** A schema it cannot read as a plain
  JSON object is forwarded unchanged and counted as `unreadable`; a narrowing
  that throws is forwarded unchanged and counted as `failed`.
- **Dropping `additionalProperties` is a trade, and the trade is worth naming.**
  On the provider that rejects the keyword, keeping it means *every* request in
  the session fails with HTTP 400 before any tool is called — the session is
  unusable. Dropping it means requests go through and a model that fills the
  object with a key the server did not declare gets an ordinary tool-level error
  for that one call. The failure moves from "nothing works" to "this call was
  wrong", which is why `drop` is the default; `keep` exists for a provider that
  accepts the keyword.
- **`inline-ref` only inlines a reference it can resolve offline.** An `http(s)`
  URL, a pointer into a document this plugin was not given, a cycle and anything
  past the expansion budget are left exactly as the server wrote them and named
  in `snapshot().unresolvedRefs` — the plugin has no network access and does not
  invent a target. If the provider rejects an unresolvable `$ref` too, that
  declaration cannot be repaired here and `unresolvedRefs` is the list to take
  to the server's author.
- **It does not mutate the schema it was handed.** The server's own object is
  left intact; the caller gets a copy.

## Compatibility

- Peer dependencies: `@deepseek-ai/cordis` (`^4.0.2 || >=4.0.5-alpha.1 <5`) and
  `@deepseek-ai/dsh-tools` (`>=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.1 ||
  >=0.2.1-alpha.2 <0.3.0`).
- **One seam, shared with `@argszero/dsh-mcp-tool-filter`.** That plugin decides
  *whether* a tool is registered; this one decides *what schema* it is registered
  with. Two plugins on one seam must chain, and this one does: the wrapper
  captures the `register` it found at mount and calls that, rather than reading
  `ctx.tools.register` again — which would be this plugin calling itself.
  Unmount restores the captured function only when this mount installed it as an
  own property, so a plugin that mounted earlier keeps its shadow.
- Zero runtime dependencies.

## License

MIT
