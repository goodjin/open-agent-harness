import { Config } from "@/config/config"
import { PermissionNext } from "@/permission/next"
import { Policy } from "@/permission/policy"
import { Truncate } from "@/tool/truncation"
import { AgentTemplate } from "./schema"

const CORE: Config.Permission = {
  doom_loop: "ask",
  external_directory: {
    [Truncate.GLOB]: "allow",
  },
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  read: {
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
}

function legacy(policy: Policy.Model): PermissionNext.Ruleset {
  return Policy.toLegacy(policy)
}

export async function buildPolicy(meta: AgentTemplate.Meta): Promise<Policy.Model> {
  const cfg = await Config.get().catch(() => undefined)
  const perm = AgentTemplate.permission(meta)
  const inherited = perm.inherit ? Policy.fromConfig(cfg?.permission ?? {}, "user") : { rules: [] }
  const core = Policy.fromConfig(CORE, "default")
  const agent = Policy.fromTemplate(perm, "agent")
  const base = {
    rules: agent.rules.filter((rule) => rule.permission === "*" && rule.action === "allow"),
  }
  const override = {
    rules: agent.rules.filter((rule) => rule.permission !== "*" || rule.action !== "allow"),
  }
  const denies = {
    rules: inherited.rules.filter((rule) => rule.action === "deny"),
  }

  if (perm.policy === "inherit") {
    return Policy.merge(core, inherited, agent)
  }

  if (perm.policy === "allow") {
    return Policy.merge(base, core, inherited, override, denies)
  }

  return Policy.merge(core, inherited, agent, denies)
}

export async function buildPermission(meta: AgentTemplate.Meta): Promise<PermissionNext.Ruleset> {
  return legacy(await buildPolicy(meta))
}
