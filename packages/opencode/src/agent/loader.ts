import path from "path"
import fs from "fs/promises"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { AgentTemplate as Schema } from "./schema"
import { Metrics } from "@/observability/metrics"

const log = Log.create({ service: "agent-loader" })

/**
 * Built-in default agent - always available regardless of how the package is distributed.
 * Used as a fallback when no agents are found from any directory.
 */
export const BUILTIN_DEFAULT_AGENT: AgentTemplate = {
  id: "default",
  name: "Default Agent",
  dir: "<builtin>",
  source: "builtin",
  meta: {
    id: "default",
    name: "Default Agent",
    role: "You are a helpful AI assistant that can assist with coding, debugging, and general software development tasks.",
    description: "The default agent template for general-purpose assistance. Use this agent for most tasks unless a specialized agent is more appropriate.",
    mode: "primary",
    entry: {
      primary: true,
      delegable: true,
      mentionable: true,
      default: true,
      hidden: false,
    },
    capability: {
      purpose: "general",
      tags: [],
      cost: "medium",
      writes: true,
    },
    hidden: false,
    runner: "chat",
    workflow_mode: "auto",
    allowed_tools: ["edit", "read", "glob", "grep", "list", "bash", "task", "webfetch", "websearch", "codesearch", "lsp", "external_directory", "todowrite", "todoread", "question"],
    denied_tools: [],
    inherit_permissions: true,
    permission_mode: "custom",
  },
  identity: "",
  rules: "",
}

/**
 * Represents a loaded agent template with parsed files.
 */
export interface AgentTemplate {
  id: string
  name: string
  dir: string
  source: "package" | "user" | "builtin"
  meta: Schema.Meta
  identity: string
  rules: string
}

export interface AgentTemplateDiagnostic {
  dir: string
  source: "package" | "user" | "builtin"
  level: "warning"
  message: string
}

export interface AgentTemplateStatus {
  dir: string
  source: "package" | "user" | "builtin"
  id: string | undefined
  valid: boolean
  errors: string[]
}

interface Entry {
  template?: AgentTemplate
  status: AgentTemplateStatus
}

/**
 * AgentTemplateLoader scans the config/agents/ directory for agent templates.
 * Each template is expected in its own subdirectory with meta.json, identity.md, and rules.md.
 */
export class AgentTemplateLoader {
  private baseDirs: string[]
  private fallbackDir: string
  private diagnostics: AgentTemplateDiagnostic[] = []

  constructor(baseDir?: string | string[], fallbackDir?: string) {
    this.baseDirs = [baseDir ?? []].flat().filter((dir) => dir.length > 0)
    this.fallbackDir = fallbackDir ?? path.join(import.meta.dir, "..", "..", "config", "agents")
  }

  /**
   * Load all agent templates from the config/agents/ directory.
   * Malformed configs are logged as warnings but don't crash loading.
   */
  async loadAll(): Promise<AgentTemplate[]> {
    return (await this.load()).templates
  }

  async load(): Promise<{ templates: AgentTemplate[]; diagnostics: AgentTemplateDiagnostic[]; statuses: AgentTemplateStatus[] }> {
    const start = Date.now()
    this.diagnostics = []
    const map = new Map<string, AgentTemplate>()
    const statuses: AgentTemplateStatus[] = []

    for (const item of await this.loadFromDir(this.fallbackDir, "package")) {
      if (item.template) map.set(item.template.id, item.template)
      statuses.push(item.status)
    }

    for (const dir of this.baseDirs) {
      for (const item of await this.loadFromDir(dir, "user")) {
        if (item.template) map.set(item.template.id, item.template)
        statuses.push(item.status)
      }
    }

    if (!map.has(BUILTIN_DEFAULT_AGENT.id)) {
      map.set(BUILTIN_DEFAULT_AGENT.id, {
        ...BUILTIN_DEFAULT_AGENT,
        dir: "<builtin>",
        source: "builtin",
      })
    }

    const templates = [...map.values()].sort((a, b) => {
      if (a.id === "default") return -1
      if (b.id === "default") return 1
      return a.id.localeCompare(b.id)
    })
    log.debug("loaded agent templates", { count: templates.length })
    Metrics.emit("opencode_agent_load_total", { source: "all", status: "ok" }, templates.length)
    Metrics.time("opencode_agent_load_duration_ms", { source: "all" }, start)
    return { templates, diagnostics: this.diagnostics, statuses }
  }

  async inspect(dir?: string): Promise<AgentTemplateStatus[]> {
    if (dir) return await this.inspectDir(dir, "user")
    return (await this.load()).statuses
  }

  getDiagnostics(): AgentTemplateDiagnostic[] {
    return this.diagnostics
  }

  async signature(): Promise<string> {
    const dirs = [this.fallbackDir, ...this.baseDirs]
    const stats = await Promise.all(
      dirs.map(async (dir) => {
        try {
          const files = await this.files(dir)
          return await Promise.all(
            files.map(async (file) => {
              try {
                const stat = await fs.stat(file)
                return `${file}:${stat.mtimeMs}:${stat.size}`
              } catch {
                return `${file}:missing`
              }
            }),
          )
        } catch {
          return [`${dir}:missing`]
        }
      }),
    )
    return stats.flat().sort().join("|")
  }

  private warn(input: { dir: string; source: "package" | "user" | "builtin"; message: string }) {
    this.diagnostics.push({
      dir: input.dir,
      source: input.source,
      level: "warning",
      message: input.message,
    })
    log.warn("agent template warning", input)
  }

  private async files(dir: string): Promise<string[]> {
    const meta = await Glob.scan("*/meta.json", { cwd: dir, absolute: true })
    const docs = await Promise.all(
      meta.map(async (file) => {
        const root = path.dirname(file)
        return [file, path.join(root, "identity.md"), path.join(root, "rules.md")]
      }),
    )
    return docs.flat()
  }

  private async loadFromDir(dir: string, source: "package" | "user"): Promise<Entry[]> {
    const entries: Entry[] = []

    try {
      await fs.access(dir)
    } catch {
      log.debug("agents directory does not exist", { path: dir })
      return entries
    }

    const metaFiles = (await Glob.scan("*/meta.json", { cwd: dir, absolute: true })).sort()

    log.debug("discovered agent templates", { count: metaFiles.length, dir })

    for (const metaPath of metaFiles) {
      const agentDir = path.dirname(metaPath)
      const agentId = path.basename(agentDir)

      const item = await this.loadTemplate(agentDir, agentId, source)
      if (item) entries.push(item)
    }

    const valid = entries.filter((item): item is Entry & { template: AgentTemplate } => !!item.template)
    const errors = Schema.validateRegistry(valid.map((item) => ({ dir: path.basename(item.template.dir), meta: item.template.meta })))
    for (const error of errors) this.warn({ dir, source, message: error })
    const duplicate = new Set(
      errors
        .map((error) => error.match(/^Duplicate agent id '([^']+)'/)?.[1])
        .filter((id): id is string => !!id),
    )
    if (duplicate.size === 0) return entries
    return entries.map((item) => {
      if (!item.template || !duplicate.has(item.template.id)) return item
      return {
        status: {
          ...item.status,
          valid: false,
          errors: [...item.status.errors, `Duplicate agent id '${item.template.id}'`],
        },
      }
    })
  }

  /**
   * Load a single agent template from a directory.
   */
  private async loadTemplate(agentDir: string, agentId: string, source: "package" | "user"): Promise<Entry | undefined> {
    const metaPath = path.join(agentDir, "meta.json")
    const identityPath = path.join(agentDir, "identity.md")
    const rulesPath = path.join(agentDir, "rules.md")
    const errors: string[] = []

    try {
      const parsed = await Bun.file(metaPath).json()
      const result = Schema.Meta.safeParse(parsed)

      if (!result.success) {
        errors.push(...result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`))
        this.warn({ dir: agentDir, source, message: `invalid meta.json for agent '${agentId}': ${errors.join("; ")}` })
        return { status: { dir: agentDir, source, id: undefined, valid: false, errors } }
      }

      errors.push(...Schema.validateTemplate({ dir: agentDir, meta: result.data }))
      if (errors.length > 0) {
        this.warn({ dir: agentDir, source, message: errors.join("; ") })
        return { status: { dir: agentDir, source, id: result.data.id, valid: false, errors } }
      }

      const template = {
        id: result.data.id,
        name: result.data.name,
        dir: agentDir,
        source,
        meta: result.data,
        identity: await this.read(identityPath, agentId, "identity.md"),
        rules: await this.read(rulesPath, agentId, "rules.md"),
      }
      return { template, status: { dir: agentDir, source, id: template.id, valid: true, errors: [] } }
    } catch (err) {
      const msg = err instanceof SyntaxError ? `malformed JSON in meta.json for agent '${agentId}'` : `failed to read meta.json for agent '${agentId}'`
      errors.push(`${msg}: ${String(err)}`)
      this.warn({ dir: agentDir, source, message: errors.join("; ") })
      return { status: { dir: agentDir, source, id: undefined, valid: false, errors } }
    }
  }

  private async read(file: string, agent: string, name: string) {
    try {
      return await Bun.file(file).text()
    } catch {
      log.debug(`${name} not found for agent`, { agent })
      return ""
    }
  }

  private async inspectDir(dir: string, source: "package" | "user"): Promise<AgentTemplateStatus[]> {
    const old = this.diagnostics
    this.diagnostics = []
    try {
      await fs.access(path.join(dir, "meta.json"))
      const item = await this.loadTemplate(dir, path.basename(dir), source)
      return [item?.status ?? { dir, source, id: undefined, valid: false, errors: ["Invalid template"] }]
    } catch {
      return await this.loadFromDir(dir, source).then((items) => items.map((item) => item.status))
    } finally {
      this.diagnostics = old
    }
  }
}
