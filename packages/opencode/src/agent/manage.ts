import path from "path"
import { HTTPException } from "hono/http-exception"
import { mergeDeep } from "remeda"
import z from "zod"
import { Config } from "@/config/config"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@/util/glob"
import { AgentTemplateLoader, BUILTIN_DEFAULT_AGENT } from "./loader"
import { resetRegistry } from "./registry"
import { AgentTemplate as Template } from "./schema"
import { BUILTIN_AGENTS } from "./builtin.generated"

export namespace AgentManage {
  export const Source = z.enum(["builtin", "package", "user", "project"])
  export type Source = z.infer<typeof Source>
  export const Kind = z.enum(["agent", "skill"])
  export type Kind = z.infer<typeof Kind>

  export const Scope = z.enum(["user", "project"])
  export type Scope = z.infer<typeof Scope>

  const Action = z.enum(["create", "update"])

  export const Diagnostic = z
    .object({
      level: z.enum(["error", "warning"]),
      message: z.string(),
      source: Source.optional(),
      dir: z.string().optional(),
      field: z.string().optional(),
      category: z.string().optional(),
    })
    .meta({ ref: "AgentManageDiagnostic" })
  export type Diagnostic = z.infer<typeof Diagnostic>

  const Effective = z
    .object({
      name: z.string(),
      description: z.string(),
      mode: Template.RuntimeMode,
      entry: Template.Entry,
      capability: Template.Capability,
      runner: Template.Runner,
      hidden: z.boolean(),
      disabled: z.boolean(),
      model: z.string().optional(),
      variant: z.string().optional(),
      color: z
        .union([
          z.string().regex(/^#[0-9a-fA-F]{6}$/),
          z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
        ])
        .optional(),
      permission: z.record(z.string(), z.unknown()).optional(),
    })
    .meta({ ref: "AgentManageEffective" })

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      disabled: z.boolean(),
      kind: Kind,
      source: Source,
      editable: z.boolean(),
      dir: z.string().optional(),
      meta: Template.Meta,
      identity: z.string(),
      rules: z.string(),
      effective: Effective,
      diagnostics: Diagnostic.array(),
    })
    .meta({ ref: "AgentManageInfo" })
  export type Info = z.infer<typeof Info>

  export const ValidateInput = z
    .object({
      scope: Scope.default("project"),
      action: Action.default("update"),
      meta: z.unknown(),
      identity: z.string().optional(),
      rules: z.string().optional(),
    })
    .meta({ ref: "AgentManageValidateInput" })
  export type ValidateInput = z.infer<typeof ValidateInput>

  export const ValidateOutput = z
    .object({
      valid: z.boolean(),
      meta: Template.Meta.optional(),
      diagnostics: Diagnostic.array(),
    })
    .meta({ ref: "AgentManageValidateOutput" })
  export type ValidateOutput = z.infer<typeof ValidateOutput>

  export const SaveInput = z
    .object({
      scope: Scope.default("project"),
      meta: Template.Meta,
      identity: z.string().default(""),
      rules: z.string().default(""),
    })
    .meta({ ref: "AgentManageSaveInput" })
  export type SaveInput = z.infer<typeof SaveInput>

  export const PatchInput = z
    .object({
      scope: Scope.default("project"),
      meta: Template.Meta.optional(),
      identity: z.string().optional(),
      rules: z.string().optional(),
    })
    .meta({ ref: "AgentManagePatchInput" })
  export type PatchInput = z.infer<typeof PatchInput>

  export const StateInput = z
    .object({
      scope: Scope.default("project"),
      disabled: z.boolean(),
    })
    .meta({ ref: "AgentManageStateInput" })
  export type StateInput = z.infer<typeof StateInput>

  type Item = {
    id: string
    name: string
    dir: string
    source: Source
    kind: Kind
    meta: Template.Meta
    identity: string
    rules: string
    diagnostics: Diagnostic[]
  }

  const safe = /^[A-Za-z0-9._-]+$/

  function pkg() {
    return path.join(import.meta.dir, "..", "..", "config", "agents")
  }

  function claude() {
    return path.join(Global.Path.home, ".claude", "skills")
  }

  function root(scope: Scope) {
    if (scope === "user") return path.join(Global.Path.config, "agents")
    return path.join(Instance.worktree, ".opencode", "agents")
  }

  function file(scope: Scope) {
    if (scope === "user") return undefined
    return path.join(Instance.worktree, ".opencode", "opencode.json")
  }

  function fail(status: 400 | 404 | 409, message: string): never {
    throw new HTTPException(status, { message })
  }

  async function text(file: string) {
    const item = Bun.file(file)
    if (!(await item.exists())) return ""
    return await item.text()
  }

  async function json(file: string) {
    const item = Bun.file(file)
    if (!(await item.exists())) return {}
    return (await item.json()) as Config.Info
  }

  function category(field: string | undefined) {
    if (!field) return undefined
    if (field === "logo" || field.startsWith("logo.")) return "metadata.logo"
    if (field === "instructions" || field.startsWith("instructions.")) return "metadata.instructions"
    if (field === "contracts" || field.startsWith("contracts.")) return "metadata.contracts"
    if (field === "collaboration" || field.startsWith("collaboration.")) return "metadata.collaboration"
    if (field === "runtime_boundary" || field.startsWith("runtime_boundary.")) return "metadata.runtime_boundary"
    if (field === "completion" || field.startsWith("completion.")) return "metadata.completion"
    if (field === "observability" || field.startsWith("observability.")) return "metadata.observability"
    if (field === "lifecycle" || field.startsWith("lifecycle.")) return "metadata.lifecycle"
    return undefined
  }

  function validate(scope: Scope, meta: unknown): ValidateOutput {
    const diagnostics: Diagnostic[] = []
    const result = Template.Meta.safeParse(meta)
    if (!result.success) {
      diagnostics.push(
        ...result.error.issues.map((issue) => {
          const field = issue.path.join(".") || undefined
          return {
            level: "error" as const,
            field,
            category: category(field),
            message: issue.message,
          }
        }),
      )
      return { valid: false, diagnostics }
    }

    if (!safe.test(result.data.id)) {
      diagnostics.push({
        level: "error",
        field: "id",
        message: "Agent id may only contain letters, numbers, dots, underscores, and dashes",
      })
    }

    diagnostics.push(
      ...Template.validateTemplate({ dir: path.join(root(scope), result.data.id), meta: result.data }).map(
        (message) => ({
          level: "error" as const,
          field: "id",
          message,
        }),
      ),
    )

    return { valid: diagnostics.every((item) => item.level !== "error"), meta: result.data, diagnostics }
  }

  async function scan(dir: string, source: Source) {
    const diagnostics: Diagnostic[] = []
    const items: Item[] = []
    if (!(await Filesystem.exists(dir))) return { items, diagnostics }

    const files = (await Glob.scan("*/meta.json", { cwd: dir, absolute: true })).sort()
    await Promise.all(
      files.map(async (file) => {
        const root = path.dirname(file)
        const id = path.basename(root)
        const parsed = await Bun.file(file)
          .json()
          .catch((err) => {
            diagnostics.push({
              level: "error",
              source,
              dir: root,
              message: `failed to read meta.json for agent '${id}': ${String(err)}`,
            })
            return undefined
          })
        if (!parsed) return

        const result = validate(source === "project" ? "project" : "user", parsed)
        if (!result.meta) {
          diagnostics.push(...result.diagnostics.map((item) => ({ ...item, source, dir: root })))
          return
        }

        const errors = Template.validateTemplate({ dir: root, meta: result.meta })
        if (errors.length > 0) {
          diagnostics.push(...errors.map((message) => ({ level: "error" as const, source, dir: root, message })))
          return
        }

        items.push({
          id: result.meta.id,
          name: result.meta.name,
          dir: root,
          source,
          kind: "agent",
          meta: result.meta,
          identity: await text(path.join(root, "identity.md")),
          rules: await text(path.join(root, "rules.md")),
          diagnostics: result.diagnostics.map((item) => ({ ...item, source, dir: root })),
        })
      }),
    )

    return { items, diagnostics }
  }

  async function skills() {
    const loader = new AgentTemplateLoader([root("user"), root("project")], pkg(), claude())
    return (await loader.loadAll())
      .filter((item) => item.meta.capability.purpose === "legacy_skill")
      .map(
        (item): Item => ({
          id: item.id,
          name: item.name,
          dir: item.dir,
          source: item.source === "package" ? "package" : "user",
          kind: "skill",
          meta: item.meta,
          identity: item.identity,
          rules: item.rules,
          diagnostics: [],
        }),
      )
  }

  function bundled() {
    return {
      items: BUILTIN_AGENTS.map((item): Item => ({
        id: item.id,
        name: item.name,
        dir: item.dir,
        source: "package",
        kind: "agent",
        meta: item.meta,
        identity: item.identity,
        rules: item.rules,
        diagnostics: [],
      })),
      diagnostics: [] as Diagnostic[],
    }
  }

  function effective(item: Item, cfg: Config.Agent | undefined, disabled: boolean) {
    const mode = cfg?.mode ?? Template.mode(item.meta)
    const entry = cfg?.mode ? Template.EntryDefaults[cfg.mode] : item.meta.entry
    const hidden = cfg?.hidden ?? (entry.hidden || item.meta.hidden)
    return {
      name: cfg?.name ?? item.name,
      description: cfg?.description ?? item.meta.description,
      mode,
      entry: {
        ...entry,
        hidden,
      },
      capability: item.meta.capability,
      runner: item.meta.runner,
      hidden,
      disabled,
      model:
        cfg?.model ??
        (item.meta.model_preference
          ? `${item.meta.model_preference.providerID}/${item.meta.model_preference.modelID}`
          : undefined),
      variant: cfg?.variant,
      color: cfg?.color,
      permission: cfg?.permission,
    }
  }

  async function entries() {
    const cfg = await Config.get()
    const all = await Promise.all([
      bundled(),
      skills().then((items) => ({ items, diagnostics: [] as Diagnostic[] })),
      scan(pkg(), "package"),
      scan(root("user"), "user"),
      scan(root("project"), "project"),
    ])

    const map = new Map<string, Item>()
    const diagnostics = all.flatMap((item) => item.diagnostics)
    all.flatMap((item) => item.items).forEach((item) => map.set(item.id, item))
    if (!map.has(BUILTIN_DEFAULT_AGENT.id)) {
      map.set(BUILTIN_DEFAULT_AGENT.id, {
        id: BUILTIN_DEFAULT_AGENT.id,
        name: BUILTIN_DEFAULT_AGENT.name,
        dir: BUILTIN_DEFAULT_AGENT.dir,
        source: BUILTIN_DEFAULT_AGENT.source,
        kind: "agent",
        meta: BUILTIN_DEFAULT_AGENT.meta,
        identity: BUILTIN_DEFAULT_AGENT.identity,
        rules: BUILTIN_DEFAULT_AGENT.rules,
        diagnostics: [],
      })
    }

    return [...map.values()]
      .map((item) => {
        const disabled = cfg.agent?.[item.id]?.disable === true
        return {
          id: item.id,
          name: item.name,
          disabled,
          kind: item.kind,
          source: item.source,
          editable: item.kind === "agent",
          dir: item.dir,
          meta: item.meta,
          identity: item.identity,
          rules: item.rules,
          effective: effective(item, cfg.agent?.[item.id], disabled),
          diagnostics: [
            ...item.diagnostics,
            ...diagnostics.filter((diag) => diag.dir === item.dir && !item.diagnostics.includes(diag)),
          ],
        } satisfies Info
      })
      .sort((a, b) => {
        if (a.id === cfg.default_agent) return -1
        if (b.id === cfg.default_agent) return 1
        return a.name.localeCompare(b.name)
      })
  }

  async function write(scope: Scope, item: Pick<Item, "id" | "meta" | "identity" | "rules">) {
    const diag = validate(scope, item.meta)
    if (!diag.valid) fail(400, diag.diagnostics.map((d) => d.message).join("; "))

    const dir = path.join(root(scope), item.id)
    await Filesystem.writeJson(path.join(dir, "meta.json"), item.meta)
    await Filesystem.write(path.join(dir, "identity.md"), item.identity)
    await Filesystem.write(path.join(dir, "rules.md"), item.rules)
    resetRegistry()
  }

  async function patch(scope: Scope, cfg: Config.Info) {
    if (scope === "user") {
      await Config.updateGlobal(cfg)
      resetRegistry()
      return
    }

    const target = file(scope)
    if (!target) return
    await Filesystem.writeJson(target, mergeDeep(await json(target), cfg))
    resetRegistry()
    await Instance.dispose()
  }

  function fallback(items: Info[], id: string) {
    return items.find(
      (item) =>
        item.id !== id &&
        !item.disabled &&
        item.effective.entry.primary &&
        item.effective.entry.default &&
        !item.effective.entry.hidden &&
        !item.effective.hidden,
    )?.id
  }

  export async function list() {
    return await entries()
  }

  export async function get(id: string) {
    const item = (await entries()).find((item) => item.id === id)
    if (!item) fail(404, `Agent not found: ${id}`)
    return item
  }

  export async function check(input: ValidateInput) {
    const out = validate(input.scope, input.meta)
    if (input.action !== "create" || !out.meta) return out
    if (!(await entries()).some((item) => item.id === out.meta?.id)) return out
    const diagnostics = [
      ...out.diagnostics,
      {
        level: "error" as const,
        field: "id",
        message: `Agent already exists: ${out.meta.id}`,
      },
    ]
    return { ...out, valid: false, diagnostics }
  }

  export async function create(input: SaveInput) {
    const diag = validate(input.scope, input.meta)
    if (!diag.valid) fail(400, diag.diagnostics.map((d) => d.message).join("; "))
    if ((await entries()).some((item) => item.id === input.meta.id)) fail(409, `Agent already exists: ${input.meta.id}`)

    await write(input.scope, {
      id: input.meta.id,
      meta: input.meta,
      identity: input.identity,
      rules: input.rules,
    })
    return await get(input.meta.id)
  }

  export async function update(id: string, input: PatchInput) {
    if (!safe.test(id)) fail(400, "Invalid agent id")
    const prev = await get(id)
    const meta = input.meta ?? prev.meta
    if (meta.id !== id) fail(400, "Agent id cannot be changed")

    await write(input.scope, {
      id,
      meta,
      identity: input.identity ?? prev.identity,
      rules: input.rules ?? prev.rules,
    })
    return await get(id)
  }

  export async function state(id: string, input: StateInput) {
    if (!safe.test(id)) fail(400, "Invalid agent id")
    const items = await entries()
    if (!items.some((item) => item.id === id)) fail(404, `Agent not found: ${id}`)
    const cfg = await Config.get()
    const next = input.disabled && (cfg.default_agent === id || !cfg.default_agent) ? fallback(items, id) : undefined
    if (input.disabled && (cfg.default_agent === id || !cfg.default_agent) && !next) {
      fail(400, "Cannot disable the default agent without another eligible default agent")
    }

    await patch(input.scope, {
      default_agent: next,
      agent: {
        [id]: {
          disable: input.disabled,
        },
      },
    })

    return await get(id)
  }
}
