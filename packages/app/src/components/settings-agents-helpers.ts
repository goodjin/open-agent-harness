import type {
  AgentManageDiagnostic,
  AgentManageInfo,
  AgentManagePatchInput,
  AgentManageSaveInput,
  AgentManageStateInput,
  AgentManageValidateInput,
  AgentManageValidateOutput,
} from "@opencode-ai/sdk/v2"

export type Scope = NonNullable<AgentManageSaveInput["scope"]>
export type Meta = AgentManageSaveInput["meta"]
export type Mode = NonNullable<Meta["mode"]>
export type Runner = NonNullable<Meta["runner"]>
export type Cost = NonNullable<NonNullable<Meta["capability"]>["cost"]>
export type Perm = NonNullable<Meta["permission_mode"]>
export type View = "create" | "edit"

export type Form = {
  base?: Meta
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
export const runners: Runner[] = ["chat", "workflow"]
export const costs: Cost[] = ["low", "medium", "high"]
export const perms: Perm[] = ["custom", "strict", "lax"]

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

export const blank = (): Form => ({
  base: undefined,
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

export const summary = (item: AgentManageInfo) => {
  const entry = [
    item.effective.entry.primary ? "primary" : undefined,
    item.effective.entry.delegable ? "delegable" : undefined,
    item.effective.entry.mentionable ? "mentionable" : undefined,
    item.effective.entry.default ? "default" : undefined,
    item.effective.entry.hidden ? "hidden" : undefined,
  ].filter((part): part is string => !!part)
  return `${item.effective.runner} / ${item.effective.mode}${entry.length ? ` / ${entry.join(", ")}` : ""}`
}

export const meta = (form: Form): Meta => {
  const tags = split(form.tags)
  const allowed = split(form.allowed)
  const denied = split(form.denied)
  return {
    ...form.base,
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
