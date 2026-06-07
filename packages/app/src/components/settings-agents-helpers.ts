import type {
  AgentManageDiagnostic,
  AgentManageInfo,
  AgentManagePatchInput,
  AgentManageSaveInput,
  AgentManageStateInput,
  AgentManageValidateInput,
  AgentManageValidateOutput,
} from "@open-agent-harness/sdk/v2"

export type Scope = NonNullable<AgentManageSaveInput["scope"]>
export type Meta = AgentManageSaveInput["meta"]
export type Mode = NonNullable<Meta["mode"]>
export type Runner = NonNullable<Meta["runner"]>
export type Cost = NonNullable<NonNullable<Meta["capability"]>["cost"]>
export type Perm = NonNullable<Meta["permission_mode"]>
export type View = "create" | "edit"
export type Tab = "all" | "agent" | "skill"
export type RFC = Pick<
  Meta,
  | "schema_version"
  | "agent_version"
  | "logo"
  | "instructions"
  | "contracts"
  | "collaboration"
  | "runtime_boundary"
  | "completion"
  | "observability"
  | "lifecycle"
>

export type Form = {
  base?: Meta
  raw?: RFC
  scope: Scope
  id: string
  name: string
  role: string
  description: string
  identity: string
  rules: string
  mode: Mode
  runner: Runner
  hidden: boolean
  primary: boolean
  delegable: boolean
  mentionable: boolean
  default: boolean
  entryHidden: boolean
  purpose: string
  tags: string
  cost: Cost
  writes: boolean
  perm: Perm
  allowed: string
  denied: string
  inherit: boolean
}

type Raw<T> = T | { data: T }
type Opts = { throwOnError: true }

type Manage = {
  list(params: {}, opts: Opts): Promise<unknown>
  validate(params: { agentManageValidateInput: AgentManageValidateInput }, opts: Opts): Promise<unknown>
  create(params: { agentManageSaveInput: AgentManageSaveInput }, opts: Opts): Promise<unknown>
  update(params: { id: string; agentManagePatchInput: AgentManagePatchInput }, opts: Opts): Promise<unknown>
  state(params: { id: string; agentManageStateInput: AgentManageStateInput }, opts: Opts): Promise<unknown>
}

export const scopes: Scope[] = ["project", "user"]
export const modes: Mode[] = ["primary", "subagent", "all"]
export const runners: Runner[] = ["chat", "workflow", "protocol"]
export const costs: Cost[] = ["low", "medium", "high"]
export const perms: Perm[] = ["custom", "strict", "lax"]
export const tabs: Tab[] = ["all", "agent", "skill"]

export const data = <T>(value: Raw<T>) => {
  if (typeof value === "object" && value !== null && "data" in value) return (value as { data: T }).data
  return value
}

export const split = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item): item is string => item.length > 0)

export const join = (value: string[] | undefined) => value?.join("\n") ?? ""

export const text = (value: string) => {
  const next = value.trim()
  if (!next) return
  return next
}

const clean = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter((item) => item[1] !== undefined)) as T

const keep = (item: Meta): RFC =>
  clean({
    schema_version: item.schema_version,
    agent_version: item.agent_version,
    logo: item.logo,
    instructions: item.instructions,
    contracts: item.contracts,
    collaboration: item.collaboration,
    runtime_boundary: item.runtime_boundary,
    completion: item.completion,
    observability: item.observability,
    lifecycle: item.lifecycle,
  })

const count = (value: unknown[] | undefined) => value?.length ?? 0

const field = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined

const string = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

const replacement = (value: unknown) => string(field(value, "replacement")) ?? string(field(value, "replaced_by"))

export const blank = (): Form => ({
  base: undefined,
  raw: undefined,
  scope: "project",
  id: "",
  name: "",
  role: "",
  description: "",
  identity: "",
  rules: "",
  mode: "subagent",
  runner: "chat",
  hidden: false,
  primary: false,
  delegable: true,
  mentionable: true,
  default: false,
  entryHidden: false,
  purpose: "",
  tags: "",
  cost: "medium",
  writes: false,
  perm: "custom",
  allowed: "",
  denied: "",
  inherit: false,
})

export const fill = (item: AgentManageInfo): Form => ({
  base: item.meta,
  raw: keep(item.meta),
  scope: item.source === "user" ? "user" : "project",
  id: item.meta.id,
  name: item.meta.name,
  role: item.meta.role,
  description: item.meta.description,
  identity: item.identity,
  rules: item.rules,
  mode: item.meta.mode ?? item.effective.mode,
  runner: item.meta.runner ?? item.effective.runner,
  hidden: item.meta.hidden ?? item.effective.hidden,
  primary: item.meta.entry?.primary ?? item.effective.entry.primary ?? false,
  delegable: item.meta.entry?.delegable ?? item.effective.entry.delegable ?? false,
  mentionable: item.meta.entry?.mentionable ?? item.effective.entry.mentionable ?? false,
  default: item.meta.entry?.default ?? item.effective.entry.default ?? false,
  entryHidden: item.meta.entry?.hidden ?? item.effective.entry.hidden ?? false,
  purpose: item.meta.capability?.purpose ?? item.effective.capability.purpose ?? "",
  tags: join(item.meta.capability?.tags ?? item.effective.capability.tags),
  cost: item.meta.capability?.cost ?? item.effective.capability.cost ?? "medium",
  writes: item.meta.capability?.writes ?? item.effective.capability.writes ?? false,
  perm: item.meta.permission_mode ?? "custom",
  allowed: join(item.meta.allowed_tools),
  denied: join(item.meta.denied_tools),
  inherit: item.meta.inherit_permissions ?? false,
})

export const message = (value: unknown) => (value instanceof Error ? value.message : String(value))

export const versions = (item: RFC | undefined) =>
  [
    item?.schema_version ? `schema ${item.schema_version}` : undefined,
    item?.agent_version ? `agent ${item.agent_version}` : undefined,
  ].filter((part): part is string => !!part)

export const overview = (item: RFC | undefined) => {
  const instructions = count(item?.instructions?.files) + count(item?.instructions?.model_messages)
  const input = count(item?.contracts?.input)
  const output = count(item?.contracts?.output)
  const edges = count(item?.collaboration?.edges)
  const resources = count(item?.runtime_boundary?.resource_classes)
  const artifacts = count(item?.completion?.required_artifacts)
  const life = item?.lifecycle
  const deprecated = field(life, "deprecated") === true
  return [
    instructions ? `instructions ${instructions}` : undefined,
    input || output ? `contracts ${input} input / ${output} output` : undefined,
    edges ? `edges ${edges}` : undefined,
    resources ? `resources ${resources}` : undefined,
    artifacts ? `artifacts ${artifacts}` : undefined,
    deprecated ? `deprecated${replacement(life) ? ` -> ${replacement(life)}` : ""}` : undefined,
  ].filter((part): part is string => !!part)
}

export const json = (form: Form) => JSON.stringify(form.raw ?? {}, null, 2)

export const summary = (item: AgentManageInfo) => {
  const entry = [
    item.effective.entry.primary ? "primary" : undefined,
    item.effective.entry.delegable ? "delegable" : undefined,
    item.effective.entry.mentionable ? "mentionable" : undefined,
    item.effective.entry.default ? "default" : undefined,
    item.effective.entry.hidden ? "hidden" : undefined,
  ].filter((part): part is string => !!part)
  const kind = item.kind === "skill" ? "legacy skill / " : ""
  return `${kind}${item.effective.runner} / ${item.effective.mode}${entry.length ? ` / ${entry.join(", ")}` : ""}`
}

export const typed = (items: readonly AgentManageInfo[] | undefined, tab: Tab) =>
  (items ?? []).filter((item) => tab === "all" || item.kind === tab)

export const meta = (form: Form): Meta => {
  const tags = split(form.tags)
  const allowed = split(form.allowed)
  const denied = split(form.denied)
  return {
    ...form.base,
    ...form.raw,
    id: form.id.trim(),
    name: form.name.trim(),
    role: form.role.trim(),
    description: form.description.trim(),
    mode: form.mode,
    runner: form.runner,
    hidden: form.hidden,
    entry: {
      ...form.base?.entry,
      primary: form.primary,
      delegable: form.delegable,
      mentionable: form.mentionable,
      default: form.default,
      hidden: form.entryHidden,
    },
    capability: {
      ...form.base?.capability,
      purpose: text(form.purpose),
      tags: tags.length ? tags : undefined,
      cost: form.cost,
      writes: form.writes,
    },
    permission_mode: form.perm,
    inherit_permissions: form.inherit,
    allowed_tools: allowed.length ? allowed : undefined,
    denied_tools: denied.length ? denied : undefined,
  }
}

export const input = (form: Form): AgentManageSaveInput => ({
  scope: form.scope,
  meta: meta(form),
  identity: form.identity.trim(),
  rules: form.rules.trim(),
})

export async function load(manage: Pick<Manage, "list">) {
  return data<AgentManageInfo[]>((await manage.list({}, { throwOnError: true })) as Raw<AgentManageInfo[]>)
}

export async function save(
  manage: Pick<Manage, "validate" | "create" | "update">,
  form: Form,
  action: View,
): Promise<{ ok: true; id: string; diagnostics: [] } | { ok: false; diagnostics: AgentManageDiagnostic[] }> {
  const body = input(form)
  const out = data<AgentManageValidateOutput>(
    (await manage.validate(
      { agentManageValidateInput: { ...body, action: action === "create" ? "create" : "update" } },
      { throwOnError: true },
    )) as Raw<AgentManageValidateOutput>,
  )
  if (!out.valid) return { ok: false, diagnostics: out.diagnostics }
  if (action === "create") {
    await manage.create({ agentManageSaveInput: body }, { throwOnError: true })
    return { ok: true, id: form.id.trim(), diagnostics: [] }
  }
  await manage.update({ id: form.id.trim(), agentManagePatchInput: body }, { throwOnError: true })
  return { ok: true, id: form.id.trim(), diagnostics: [] }
}

export const scope = (item: AgentManageInfo): Scope => (item.source === "user" ? "user" : "project")

export async function toggle(manage: Pick<Manage, "state">, item: AgentManageInfo) {
  await manage.state(
    {
      id: item.id,
      agentManageStateInput: {
        scope: scope(item),
        disabled: !item.disabled,
      },
    },
    { throwOnError: true },
  )
}
