import path from "path"
import { AgentTemplateLoader, type AgentTemplate, type AgentTemplateStatus } from "./loader"
import { AgentTemplate as AgentTemplateSchema } from "./schema"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { PermissionNext } from "../permission/next"
import { Policy } from "../permission/policy"
import { Global } from "../global"
import { buildPolicy } from "./permission"

const log = Log.create({ service: "agent-registry" })

/**
 * Agent metadata returned by list() - minimal info for display
 */
export interface AgentMetadata {
  id: string
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  entry: AgentTemplateSchema.Entry
  capability: AgentTemplateSchema.Capability
  runner: AgentTemplateSchema.Runner
}

/**
 * Complete agent template returned by get()
 */
export interface AgentTemplateInfo {
  id: string
  name: string
  mode: "primary" | "subagent" | "all"
  entry: AgentTemplateSchema.Entry
  capability: AgentTemplateSchema.Capability
  runner: AgentTemplateSchema.Runner
  meta: AgentTemplateSchema.Meta
  identity: string
  rules: string
  protocol?: {
    file: string
    prompt: string
  }
  requestFooter?: {
    file?: string
    prompt: string
  }
  permission: PermissionNext.Ruleset
  policy: Policy.Model
}

/**
 * AgentRegistry manages all agent templates loaded from config/agents/.
 * It provides list(), get(), and supports runtime agent switching.
 */
export class AgentRegistry {
  private loader: AgentTemplateLoader
  private cache: AgentTemplate[] | undefined
  private signature: string | undefined
  private currentAgentId: string | undefined

  constructor(baseDir?: string | string[], fallbackDir?: string, skills?: string | string[]) {
    this.loader = new AgentTemplateLoader(baseDir, fallbackDir, skills)
  }

  /**
   * Invalidate the cache to force reload on next access
   */
  invalidateCache(): void {
    this.cache = undefined
    this.signature = undefined
  }

  /**
   * Load all agent templates, using cache if available
   */
  private async loadAll(): Promise<AgentTemplate[]> {
    const signature = await this.loader.signature()
    if (this.cache === undefined || this.signature !== signature) {
      this.cache = await this.loader.loadAll()
      this.signature = signature
      log.debug("loaded agent templates", { count: this.cache.length })
    }
    return this.cache
  }

  private eligible(agent: Pick<AgentTemplate, "meta">): boolean {
    return agent.meta.entry.primary && agent.meta.entry.default && !agent.meta.entry.hidden && !agent.meta.hidden
  }

  private entry(agent: AgentTemplate, cfg: Config.Agent | undefined): AgentTemplateSchema.Entry | undefined {
    if (cfg?.disable) return undefined
    const mode = cfg?.mode
    const entry = mode ? AgentTemplateSchema.EntryDefaults[mode] : agent.meta.entry
    const hidden = cfg?.hidden ?? (agent.meta.entry.hidden || agent.meta.hidden)
    return {
      ...entry,
      hidden,
    }
  }

  async templates(dir?: string): Promise<AgentTemplateStatus[]> {
    return await this.loader.inspect(dir)
  }

  /**
   * List all available agents with minimal metadata.
   * Returns array of agent metadata (id, name, description, mode).
   */
  async list(): Promise<AgentMetadata[]> {
    const agents = await this.loadAll()
    const cfg = await Config.get()

    return agents
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.meta.description,
        mode: AgentTemplateSchema.mode(agent.meta),
        entry: agent.meta.entry,
        capability: agent.meta.capability,
        runner: agent.meta.runner,
      }))
      .sort((a, b) => {
        // Sort default agent first, then alphabetically
        if (a.id === cfg.default_agent) return -1
        if (b.id === cfg.default_agent) return 1
        return a.name.localeCompare(b.name)
      })
  }

  /**
   * Get a complete agent template by ID.
   * Returns undefined if not found.
   */
  async get(id: string): Promise<AgentTemplateInfo | undefined> {
    const agents = await this.loadAll()
    const agent = agents.find((a) => a.id === id)
    if (!agent) return undefined
    const policy = await buildPolicy(agent.meta)

    return {
      id: agent.id,
      name: agent.name,
      mode: AgentTemplateSchema.mode(agent.meta),
      entry: agent.meta.entry,
      capability: agent.meta.capability,
      runner: agent.meta.runner,
      meta: agent.meta,
      identity: agent.identity,
      rules: agent.rules,
      protocol: agent.protocol,
      requestFooter: agent.requestFooter,
      permission: Policy.toLegacy(policy),
      policy,
    }
  }

  /**
   * Get the default agent ID from config
   */
  async getDefaultId(): Promise<string | undefined> {
    const cfg = await Config.get()
    return cfg.default_agent
  }

  /**
   * Set the default agent by updating config
   */
  async setDefault(id: string): Promise<void> {
    const agents = await this.loadAll()
    const agent = agents.find((a) => a.id === id)
    if (!agent) {
      throw new Error(`Agent not found: ${id}`)
    }
    const cfg = (await Config.get()).agent?.[id]
    const entry = this.entry(agent, cfg)
    if (!entry) throw new Error(`Agent not found: ${id}`)
    if (!entry.primary) throw new Error(`Agent "${id}" is not a primary agent`)
    if (entry.hidden) throw new Error(`Agent "${id}" is hidden`)
    if (!entry.default) throw new Error(`Agent "${id}" is not default eligible`)

    await Config.update({ default_agent: id })
    log.info("set default agent", { id })
  }

  /**
   * Get the current active agent ID for this session/runtime
   */
  getCurrentId(): string | undefined {
    return this.currentAgentId
  }

  /**
   * Switch to a different agent at runtime.
   * This preserves session state - only the active agent changes.
   */
  async switch(id: string): Promise<AgentTemplateInfo | undefined> {
    const agents = await this.loadAll()
    const agent = agents.find((a) => a.id === id)
    if (!agent) return undefined
    const policy = await buildPolicy(agent.meta)

    this.currentAgentId = id
    log.info("switched agent", { id, name: agent.name })
    return {
      id: agent.id,
      name: agent.name,
      mode: AgentTemplateSchema.mode(agent.meta),
      entry: agent.meta.entry,
      capability: agent.meta.capability,
      runner: agent.meta.runner,
      meta: agent.meta,
      identity: agent.identity,
      rules: agent.rules,
      protocol: agent.protocol,
      permission: Policy.toLegacy(policy),
      policy,
    }
  }

  /**
   * Get the effective agent to use - current switched agent or default
   */
  async getEffectiveAgent(): Promise<AgentTemplateInfo | undefined> {
    if (this.currentAgentId) return this.get(this.currentAgentId)
    const id = await this.getDefaultId()
    const agent = id ? await this.get(id) : undefined
    if (agent) return agent
    const first = (await this.loadAll()).find((item) => this.eligible(item))
    if (!first) return undefined
    return this.get(first.id)
  }
}

/**
 * Global registry instance - singleton per directory
 */
const registryByDirectory = new Map<string, AgentRegistry>()

/**
 * Get the registry for the current instance directory
 */
export function getRegistry(): AgentRegistry {
  const dir = Instance.directory
  let registry = registryByDirectory.get(dir)
  if (!registry) {
    const cfg = process.env.OPENCODE_AGENT_TEMPLATE_DIR
    const pkg = path.join(path.dirname(process.execPath), "..", "config", "agents")
    registry = new AgentRegistry(
      [
        path.join(Global.Path.config, "agents"),
        path.join(Instance.worktree, ".opencode", "agents"),
        ...(cfg ? [cfg] : []),
        pkg,
      ],
      undefined,
      path.join(Global.Path.home, ".claude", "skills"),
    )
    registryByDirectory.set(dir, registry)
  }
  return registry
}

/**
 * Reset registry cache (useful for testing or config changes)
 */
export function resetRegistry(): void {
  registryByDirectory.clear()
}
