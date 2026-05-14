import path from "path"
import fs from "fs/promises"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { AgentTemplate } from "./schema"

const log = Log.create({ service: "agent-loader" })

/**
 * Represents a loaded agent template with parsed files.
 */
export interface AgentTemplate {
  id: string
  name: string
  meta: AgentTemplate.Meta
  identity: string
  rules: string
}

/**
 * AgentTemplateLoader scans the config/agents/ directory for agent templates.
 * Each template is expected in its own subdirectory with meta.json, identity.md, and rules.md.
 */
export class AgentTemplateLoader {
  private baseDir: string

  constructor(baseDir?: string) {
    // Default to config/agents relative to the package
    this.baseDir = baseDir ?? path.join(import.meta.dir, "..", "..", "config", "agents")
  }

  /**
   * Load all agent templates from the config/agents/ directory.
   * Malformed configs are logged as warnings but don't crash loading.
   */
  async loadAll(): Promise<AgentTemplate[]> {
    const agents: AgentTemplate[] = []

    try {
      await fs.access(this.baseDir)
    } catch {
      log.debug("config/agents directory does not exist", { path: this.baseDir })
      return agents
    }

    // Find all subdirectories containing meta.json
    const metaFiles = await Glob.scan("*/meta.json", {
      cwd: this.baseDir,
      absolute: true,
    })

    log.debug("discovered agent templates", { count: metaFiles.length })

    // Parse each agent template
    for (const metaPath of metaFiles) {
      const agentDir = path.dirname(metaPath)
      const agentId = path.basename(agentDir)

      try {
        const template = await this.loadTemplate(agentDir, agentId)
        if (template) {
          agents.push(template)
        }
      } catch (err) {
        log.warn("failed to load agent template", { agentId, error: String(err) })
      }
    }

    log.debug("loaded agent templates", { count: agents.length })
    return agents
  }

  /**
   * Load a single agent template from a directory.
   */
  private async loadTemplate(agentDir: string, agentId: string): Promise<AgentTemplate | null> {
    const metaPath = path.join(agentDir, "meta.json")
    const identityPath = path.join(agentDir, "identity.md")
    const rulesPath = path.join(agentDir, "rules.md")

    // Parse meta.json
    let meta: AgentTemplate.Meta
    try {
      const metaContent = await fs.readFile(metaPath, "utf-8")
      const parsed = JSON.parse(metaContent)
      const result = AgentTemplate.Meta.safeParse(parsed)

      if (!result.success) {
        log.warn("invalid meta.json for agent", {
          agentId,
          errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        })
        return null
      }

      meta = result.data
    } catch (err) {
      if (err instanceof SyntaxError) {
        log.warn("malformed JSON in meta.json for agent", { agentId, error: String(err) })
      } else {
        log.warn("failed to read meta.json for agent", { agentId, error: String(err) })
      }
      return null
    }

    // Parse identity.md
    let identity = ""
    try {
      identity = await fs.readFile(identityPath, "utf-8")
    } catch {
      log.debug("identity.md not found for agent", { agentId })
    }

    // Parse rules.md
    let rules = ""
    try {
      rules = await fs.readFile(rulesPath, "utf-8")
    } catch {
      log.debug("rules.md not found for agent", { agentId })
    }

    return {
      id: meta.id,
      name: meta.name,
      meta,
      identity,
      rules,
    }
  }
}
