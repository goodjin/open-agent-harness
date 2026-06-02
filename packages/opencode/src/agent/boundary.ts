export const Resources = [
  "filesystem",
  "network",
  "browser",
  "secret",
  "personal_data",
  "service",
  "human_contact",
  "email",
  "calendar",
  "database",
  "cloud",
  "payment",
  "crm",
  "messaging",
] as const

export const Actions = ["read", "write", "execute", "communicate", "publish", "spend", "delete", "approve"] as const

export type Resource = (typeof Resources)[number]
export type Action = (typeof Actions)[number]
export type Status = "allowed" | "denied" | "approval_required" | "blocker"

export type Rule = {
  resource: Resource
  action?: Action
  scope?: string
  reason?: string
}

export type Policy = {
  allow?: Rule[]
  deny?: Rule[]
  approval?: Rule[]
  blockers?: Rule[]
}

export type Boundary = {
  resource_classes?: Resource[]
  actions?: Partial<Record<Resource, Action[]>>
  scopes?: Partial<Record<Resource, string[]>>
  network?: Record<string, unknown>
  data?: Record<string, unknown>
  approval?: Record<string, unknown>
  rate_limits?: Record<string, unknown>
}

export type Input = {
  meta: {
    runtime_boundary?: Boundary
  }
  action?: {
    operation?: string
    executor?: {
      type?: string
      target?: string
      capabilities?: readonly string[]
    }
  }
  run?: Policy
  project?: Policy
  user?: Policy
}

export type Candidate = {
  resource: Resource
  action: Action
  scope?: string
  status: Status
  reason: string
  constraints?: {
    network?: Record<string, unknown>
    data?: Record<string, unknown>
    approval?: Record<string, unknown>
    rate_limits?: Record<string, unknown>
  }
}

export type Result = {
  candidates: Candidate[]
}

const res = new Set<string>(Resources)
const act = new Set<string>(Actions)

function valid(resource: string): resource is Resource {
  return res.has(resource)
}

function action(action: string): action is Action {
  return act.has(action)
}

function inScope(rule: Rule, scope?: string) {
  if (!rule.scope || rule.scope === "*") return true
  if (!scope) return true
  if (rule.scope.endsWith("/**")) return scope.startsWith(rule.scope.slice(0, -3))
  if (scope.endsWith("/**")) return rule.scope.startsWith(scope.slice(0, -3))
  return rule.scope === scope
}

function match(rule: Rule, item: Pick<Candidate, "resource" | "action" | "scope">) {
  if (rule.resource !== item.resource) return false
  if (rule.action && rule.action !== item.action) return false
  return inScope(rule, item.scope)
}

function find(rules: Rule[] | undefined, item: Pick<Candidate, "resource" | "action" | "scope">) {
  return rules?.find((rule) => match(rule, item))
}

function constraints(boundary: Boundary) {
  const got: Candidate["constraints"] = {}
  if (boundary.network !== undefined) got.network = boundary.network
  if (boundary.data !== undefined) got.data = boundary.data
  if (boundary.approval !== undefined) got.approval = boundary.approval
  if (boundary.rate_limits !== undefined) got.rate_limits = boundary.rate_limits
  if (Object.keys(got).length === 0) return undefined
  return got
}

function decide(input: Input, item: Omit<Candidate, "status" | "reason">): Pick<Candidate, "status" | "reason"> {
  const block = find(input.run?.blockers, item) ?? find(input.project?.blockers, item) ?? find(input.user?.blockers, item)
  if (block) {
    return {
      status: "blocker",
      reason: block.reason ?? "policy_blocker",
    }
  }

  const deny = find(input.run?.deny, item) ?? find(input.project?.deny, item) ?? find(input.user?.deny, item)
  if (deny) {
    return {
      status: "denied",
      reason: deny.reason ?? "policy_denied",
    }
  }

  const approval = find(input.run?.approval, item) ?? find(input.project?.approval, item) ?? find(input.user?.approval, item)
  if (approval) {
    return {
      status: "approval_required",
      reason: approval.reason ?? "policy_approval_required",
    }
  }

  const run = find(input.run?.allow, item)
  const project = find(input.project?.allow, item)
  if (run && project) {
    return {
      status: "allowed",
      reason: "policy_allowed",
    }
  }

  return {
    status: "blocker",
    reason: "missing_policy_authority",
  }
}

export function deriveBoundary(input: Input): Result {
  const boundary = input.meta.runtime_boundary
  const items = boundary ? explicit(boundary) : inferred(input)
  if (!items.length) return { candidates: [] }

  const candidates = items.map((item) => ({
    ...item,
    ...decide(input, item),
  }))

  return { candidates }
}

function explicit(boundary: Boundary) {
  const scope = boundary.scopes ?? {}
  const extra = constraints(boundary)
  const classes = boundary.resource_classes ?? (Object.keys(boundary.actions ?? {}) as Resource[])
  return classes.flatMap((klass) => {
    if (!valid(klass)) return []
    const actions = boundary.actions?.[klass] ?? []
    return actions
      .filter(action)
      .flatMap((act) => {
        const scopes = scope[klass]
        const items = scopes?.length ? scopes : [undefined]
        return items.map((item) => {
          return {
            resource: klass,
            action: act,
            ...(item ? { scope: item } : {}),
            ...(extra ? { constraints: extra } : {}),
          }
        })
      })
  })
}

function inferred(input: Input): Omit<Candidate, "status" | "reason">[] {
  if (!policy(input.run) && !policy(input.project) && !policy(input.user)) return []
  const keys = [
    input.action?.operation,
    input.action?.executor?.target,
    ...(input.action?.executor?.capabilities ?? []),
  ].filter((item): item is string => typeof item === "string" && item.length > 0)
  return unique(keys.flatMap(intent))
}

function intent(input: string): Omit<Candidate, "status" | "reason">[] {
  const key = input.toLowerCase()
  if (key === "task") return [{ resource: "service", action: "execute" }]
  if (key === "websearch" || key === "webfetch" || key === "network") return [{ resource: "network", action: "read" }]
  if (key === "bash" || key === "shell" || key === "command") return [{ resource: "filesystem", action: "execute" }]
  if (key === "edit" || key === "write" || key === "patch" || key === "multiedit") return [{ resource: "filesystem", action: "write" }]
  if (key === "email") return [{ resource: "human_contact", action: "communicate" }]
  return []
}

function unique(input: Omit<Candidate, "status" | "reason">[]) {
  const seen = new Set<string>()
  return input.filter((item) => {
    const key = `${item.resource}:${item.action}:${item.scope ?? ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function policy(input: Policy | undefined) {
  return Boolean(input?.allow?.length || input?.deny?.length || input?.approval?.length || input?.blockers?.length)
}
