import type { Agent } from "@/agent/agent"
import type { AgentTemplate } from "@/agent/schema"
import { AgentProtocol } from "./schema"

export namespace AgentVerification {
  export type Role = AgentProtocol.VerificationRole

  export type Info = Pick<Agent.Info, "name" | "kind" | "capability" | "verification">

  export type Injected = {
    id: string
    role: Role
    worker: string
    target: string
    reason: string
  }

  const risk = new Set([
    "api",
    "auth",
    "backend",
    "database",
    "dependency",
    "devops",
    "integration",
    "migration",
    "permissions",
    "release",
    "schema",
    "security",
  ])

  const tests = [
    /\b(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/i,
    /\b(vitest|jest|pytest)\b/i,
    /\bgo\s+test\b/i,
    /\bcargo\s+test\b/i,
  ]

  export function apply(input: { actions: AgentProtocol.Action[]; agents: Info[] }) {
    const agents = new Map(input.agents.map((item) => [item.name, item] as const))
    const ids = new Set(input.actions.map((item) => item.id))
    const cover = coverage(input.actions, agents)
    const injected: Injected[] = []
    const additions = input.actions.flatMap((action) => {
      const worker = agent(action, agents)
      if (!worker || worker.kind !== "worker") return []
      const needed = required(action, worker).filter((role) => !covered(cover, action.id, role))
      const first = needed.find((role) => role === "test")
      const testID = first ? id(ids, `${action.id}_test`) : cover.get(action.id)?.test
      return needed.map((role) => {
        const cfg = policy(worker)
        const target = verifier(role, worker, agents, cfg)
        const current = role === "test" ? (testID ?? id(ids, `${action.id}_test`)) : id(ids, `${action.id}_review`)
        const deps = role === "review" && testID ? [action.id, testID] : [action.id]
        const anchor = role === "review" && testID ? testID : action.id
        const reason = why(action, worker, role)
        injected.push({ id: current, role, worker: action.id, target, reason })
        return {
          anchor,
          action: {
            type: "action",
            id: current,
            title: `${role === "test" ? "Test" : "Review"} ${action.title}`,
            description: reason,
            operation: `verification_${role}`,
            executor: { type: "agent", target, capabilities: ["verification", role] },
            input: {
              prompt: prompt(role, action, reason, cfg.test_commands),
            },
            depends_on: deps,
            context_refs: action.context_refs,
            verification: {
              role,
              worker: action.id,
              required: true,
              reason,
              system: true,
              allow_skip_on_no_change: role === "test" ? cfg.skip_test_on_no_change : false,
            },
            result_policy: "structured",
          } satisfies AgentProtocol.Action,
        }
      })
    })
    const by = new Map<string, typeof additions>()
    for (const item of additions) by.set(item.anchor, [...(by.get(item.anchor) ?? []), item])
    const seen = new Set<string>()
    const actions = input.actions.flatMap((action) => [action, ...flush(action.id, by, seen)])
    const rest = additions.filter((item) => !seen.has(item.action.id)).map((item) => item.action)
    actions.push(...rest)
    return { actions, injected }
  }

  function flush(
    anchor: string,
    by: Map<string, { anchor: string; action: AgentProtocol.Action }[]>,
    seen: Set<string>,
  ): AgentProtocol.Action[] {
    return (by.get(anchor) ?? []).flatMap((item) => {
      if (seen.has(item.action.id)) return []
      seen.add(item.action.id)
      return [item.action, ...flush(item.action.id, by, seen)]
    })
  }

  export function nochange(input: { action: AgentProtocol.Action; output: string }) {
    if (input.action.verification?.role !== "test") return
    if (input.action.verification.allow_skip_on_no_change === false) return
    const out = input.output.toLowerCase()
    const empty =
      /\bno files? changed\b/.test(out) ||
      /\bchanged_files\s*[:：]\s*(none|\[\s*\]|no|n\/a|无|没有)/.test(out) ||
      /\bchanged files\s*[:：]\s*(none|\[\s*\]|no|n\/a|无|没有)/.test(out) ||
      /没有(?:文件)?改动|未修改(?:任何)?文件/.test(input.output)
    if (!empty) return
    const side =
      /\b(applied|ran)\s+migration\b/.test(out) ||
      /\b(deployed|published|created resource|deleted resource|modified database|wrote to database)\b/.test(out) ||
      /执行了迁移|已经部署|已经发布|修改了数据库|写入了数据库/.test(input.output)
    if (side) return
    return [
      "Verification test skipped.",
      `worker: ${input.action.verification.worker ?? "unknown"}`,
      "reason: worker summary reports no changed files and no external side effects.",
      "review verification remains required.",
    ].join("\n")
  }

  function policy(agent: Info): AgentTemplate.Verification {
    return {
      required: agent.verification?.required ?? [],
      on_write: agent.verification?.on_write ?? ["review"],
      high_risk: agent.verification?.high_risk ?? ["test", "review"],
      test_verifier: agent.verification?.test_verifier,
      review_verifier: agent.verification?.review_verifier,
      test_commands: agent.verification?.test_commands ?? [],
      risk: agent.verification?.risk,
      skip_test_on_no_change: agent.verification?.skip_test_on_no_change ?? true,
    }
  }

  function required(action: AgentProtocol.Action, agent: Info) {
    const cfg = policy(agent)
    const roles = new Set<Role>(cfg.required)
    if (agent.capability.writes !== false) for (const role of cfg.on_write) roles.add(role)
    if (risky(action, agent, cfg)) for (const role of cfg.high_risk) roles.add(role)
    return (["test", "review"] as const).filter((role) => roles.has(role))
  }

  function risky(action: AgentProtocol.Action, agent: Info, cfg: AgentTemplate.Verification) {
    if (cfg.risk === "high") return true
    if (agent.capability.cost === "high") return true
    if (agent.capability.tags.some((tag) => risk.has(tag))) return true
    if (risk.has(agent.name)) return true
    if (cfg.test_commands.length > 0) return true
    const body = [action.operation, action.description, action.reason, JSON.stringify(action.input ?? {})].join("\n")
    return tests.some((item) => item.test(body))
  }

  function why(action: AgentProtocol.Action, agent: Info, role: Role) {
    if (role === "test" && agent.verification?.test_commands?.length) {
      return `System required test verification because worker '${agent.name}' declares test commands.`
    }
    if (role === "test") return `System required test verification for high-risk worker '${agent.name}'.`
    if (agent.capability.writes !== false) return `System required review verification because worker '${agent.name}' can write.`
    return `System required review verification for worker '${agent.name}'.`
  }

  function coverage(actions: AgentProtocol.Action[], agents: Map<string, Info>) {
    const map = new Map<string, Partial<Record<Role, string>>>()
    for (const action of actions) {
      const current = agent(action, agents)
      if (current?.kind !== "verifier") continue
      for (const dep of action.depends_on) {
        const roles = map.get(dep) ?? {}
        const role = action.verification?.role ?? "review"
        roles[role] = action.id
        map.set(dep, roles)
      }
    }
    return map
  }

  function covered(input: Map<string, Partial<Record<Role, string>>>, id: string, role: Role) {
    return !!input.get(id)?.[role]
  }

  function agent(action: AgentProtocol.Action, agents: Map<string, Info>) {
    if (action.executor.type !== "agent") return
    if (action.executor.target !== "auto") return agents.get(action.executor.target)
    const wants = new Set(action.executor.capabilities)
    return [...agents.values()]
      .filter((item) => item.kind === "worker")
      .map((item) => ({
        item,
        score:
          (item.capability.purpose === action.operation ? 3 : 0) +
          (wants.has(item.capability.purpose) ? 3 : 0) +
          item.capability.tags.filter((tag) => wants.has(tag)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.item
  }

  function verifier(role: Role, agent: Info, agents: Map<string, Info>, cfg: AgentTemplate.Verification) {
    const named = role === "test" ? cfg.test_verifier : cfg.review_verifier
    if (named) return named
    const paired = `${agent.name}-verifier`
    if (agents.has(paired)) return paired
    if (role === "review" && agents.has("technical-reviewer")) return "technical-reviewer"
    return "verifier"
  }

  function id(ids: Set<string>, base: string) {
    if (!ids.has(base)) {
      ids.add(base)
      return base
    }
    const found = Array.from({ length: 100 }, (_, index) => `${base}_${index + 2}`).find((item) => !ids.has(item))
    if (!found) {
      const next = `${base}_${ids.size + 1}`
      ids.add(next)
      return next
    }
    ids.add(found)
    return found
  }

  function prompt(role: Role, action: AgentProtocol.Action, reason: string, commands: string[]) {
    return [
      `Run ${role} verification for worker action '${action.id}'.`,
      reason,
      role === "test"
        ? "Focus on executable checks, test commands, reproducible validation, and regression evidence."
        : "Focus on implementation quality, task completeness, changed files, risks, and acceptance criteria.",
      commands.length ? `Suggested test commands: ${commands.join(", ")}` : "",
      "Use the worker handoff package that the runtime will attach before execution.",
    ]
      .filter((item) => item.length > 0)
      .join("\n")
  }
}
