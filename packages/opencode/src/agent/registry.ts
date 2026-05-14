import { AgentTemplateLoader, type AgentTemplate } from "./loader"
import { AgentTemplate as AgentTemplateSchema } from "./schema"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

const log = Log.create({ service: "agent-registry" })

/**
 * Agent metadata returned by list() - minimal info for display
 */
export interface AgentMetadata {
  id: string
  name: string
  description: string
  mode: "auto" | "manual" | "supervision"
}

/**
 * Complete agent template returned by get()
 */
export interface AgentTemplateInfo {
  id: string
  name: string
  meta: AgentTemplateSchema.Meta
  identity: string
  rules: string
}

/**
 * AgentRegistry manages all agent templates loaded from config/agents/.
 * It provides list(), get(), and supports runtime agent switching.
 */
export class AgentRegistry {
  private loader: AgentTemplateLoader
  private cache: AgentTemplate[] | undefined
  private currentAgentId: string | undefined

  constructor(baseDir?: string) {
    this.loader = new AgentTemplateLoader(baseDir)
  }

  /**
   * Invalidate the cache to force reload on next access
   */
  invalidateCache(): void {
    this.cache = undefined
  }

  /**
   * Load all agent templates, using cache if available
   */
  private async loadAll(): Promise<AgentTemplate[]> {
    if (this.cache === undefined) {
      this.cache = await this.loader.loadAll()
      log.debug("loaded agent templates", { count: this.cache.length })
    }
    return this.cache
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
        mode: agent.meta.workflow_mode ?? "auto",
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

    return {
      id: agent.id,
      name: agent.name,
      meta: agent.meta,
      identity: agent.identity,
      rules: agent.rules,
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

    this.currentAgentId = id
    log.info("switched agent", { id, name: agent.name })
    return {
      id: agent.id,
      name: agent.name,
      meta: agent.meta,
      identity: agent.identity,
      rules: agent.rules,
    }
  }

  /**
   * Get the effective agent to use - current switched agent or default
   */
  async getEffectiveAgent(): Promise<AgentTemplateInfo | undefined> {
    const id = this.currentAgentId ?? (await this.getDefaultId())
    if (!id) return undefined
    return this.get(id)
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
    registry = new AgentRegistry()
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
