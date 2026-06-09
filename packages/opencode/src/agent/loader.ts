import path from "path"
import fs from "fs/promises"
import { Glob } from "../util/glob"
import { Log } from "../util/log"
import { AgentTemplate as Schema } from "./schema"
import { Metrics } from "@/observability/metrics"
import { ConfigMarkdown } from "@/config/markdown"
import { BUILTIN_AGENTS } from "./builtin.generated"

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
    role: "You are OpenCode's default project coordinator. You classify request scale, declare Agent Protocol DSL work graphs, and route each unit to the right planner or specialist.",
    description: "Default entry agent for intent clarification, scale assessment, DSL-based task decomposition, agent routing, and result synthesis.",
    mode: "primary",
    entry: {
      primary: true,
      delegable: true,
      mentionable: true,
      default: true,
      hidden: false,
    },
    capability: {
      purpose: "coordination",
      tags: ["coordination", "planning", "routing", "protocol"],
      cost: "medium",
      writes: false,
    },
    hidden: false,
    runner: "protocol",
    workflow_mode: "auto",
    allowed_tools: ["task", "question", "read", "glob", "grep", "codesearch", "lsp", "external_directory"],
    denied_tools: [
      "edit",
      "write",
      "apply_patch",
      "list",
      "bash",
      "webfetch",
      "websearch",
      "todowrite",
      "todoread",
    ],
    inherit_permissions: false,
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
  protocol?: {
    file: string
    prompt: string
  }
}

export interface AgentTemplateDiagnostic {
  dir: string
  source: "package" | "user" | "builtin"
  level: "warning"
  message: string
  field?: string
  category?: string
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
  private skills: string[]
  private diagnostics: AgentTemplateDiagnostic[] = []

  constructor(baseDir?: string | string[], fallbackDir?: string, skills?: string | string[]) {
    this.baseDirs = [baseDir ?? []].flat().filter((dir) => dir.length > 0)
    this.fallbackDir = fallbackDir ?? path.join(import.meta.dir, "..", "..", "config", "agents")
    this.skills = [skills ?? []].flat().filter((dir) => dir.length > 0)
  }

  /**
   * Load all agent templates from the config/agents/ directory.
   * Malformed configs are logged as warnings but don't crash loading.
   */
  async loadAll(): Promise<AgentTemplate[]> {
    return (await this.load()).templates
  }

  async load(): Promise<{
    templates: AgentTemplate[]
    diagnostics: AgentTemplateDiagnostic[]
    statuses: AgentTemplateStatus[]
  }> {
    const start = Date.now()
    this.diagnostics = []
    const map = new Map<string, AgentTemplate>()
    const statuses: AgentTemplateStatus[] = []

    for (const item of BUILTIN_AGENTS) {
      map.set(item.id, item)
    }

    for (const item of await this.loadSkills(this.fallbackDir, "package")) {
      map.set(item.id, item)
    }
    for (const item of await this.loadFromDir(this.fallbackDir, "package")) {
      if (item.template) map.set(item.template.id, item.template)
      statuses.push(item.status)
    }

    for (const dir of this.baseDirs) {
      for (const item of await this.loadSkills(dir, "user")) {
        map.set(item.id, item)
      }
      for (const item of await this.loadFromDir(dir, "user")) {
        if (item.template) map.set(item.template.id, item.template)
        statuses.push(item.status)
      }
    }

    for (const dir of this.skills) {
      for (const item of await this.loadSkills(dir, "user")) {
        map.set(item.id, item)
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
    const dirs = [this.fallbackDir, ...this.baseDirs, ...this.skills]
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

  private warn(input: {
    dir: string
    source: "package" | "user" | "builtin"
    message: string
    field?: string
    category?: string
  }) {
    this.diagnostics.push({
      dir: input.dir,
      source: input.source,
      level: "warning",
      message: input.message,
      field: input.field,
      category: input.category,
    })
    log.warn("agent template warning", input)
  }

  private async files(dir: string): Promise<string[]> {
    const meta = await Glob.scan("*/meta.json", { cwd: dir, absolute: true })
    const skills = await Promise.all(
      this.skillRoots(dir).map(async (root) => {
        try {
          return await Glob.scan("*/SKILL.md", { cwd: root, absolute: true })
        } catch {
          return []
        }
      }),
    )
    const docs = await Promise.all(
      meta.map(async (file) => {
        const root = path.dirname(file)
        const raw = await Bun.file(file).json().catch(() => undefined)
        const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
        const protocol = cfg.protocol && typeof cfg.protocol === "object" && !Array.isArray(cfg.protocol)
          ? (cfg.protocol as Record<string, unknown>).file
          : undefined
        const instructions = cfg.instructions && typeof cfg.instructions === "object" && !Array.isArray(cfg.instructions)
          ? cfg.instructions as Record<string, unknown>
          : undefined
        const files = Array.isArray(instructions?.files) ? instructions.files : []
        const docs = [
          file,
          path.join(root, "identity.md"),
          path.join(root, "rules.md"),
        ]
        if (typeof protocol === "string") {
          docs.push(path.join(root, protocol), path.join(path.dirname(path.dirname(root)), "protocol", protocol))
        }
        docs.push(
          ...files.flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return []
            const target = (item as Record<string, unknown>).path
            if (typeof target !== "string") return []
            if (target.includes("${") && !target.startsWith("${agent.dir}/") && !target.startsWith("${agent.root}/")) return []
            return [this.instruction(root, target)]
          }),
        )
        return docs
      }),
    )
    return [...docs.flat(), ...skills.flat()]
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
    const errors = Schema.validateRegistry(
      valid.map((item) => ({ dir: path.basename(item.template.dir), meta: item.template.meta })),
    )
    for (const error of errors) this.warn({ dir, source, message: error })
    const duplicate = new Set(
      errors.map((error) => error.match(/^Duplicate agent id '([^']+)'/)?.[1]).filter((id): id is string => !!id),
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

  private skillRoots(dir: string) {
    const base = path.basename(dir)
    if (base === "skill" || base === "skills") return [dir]
    const root = base === "agent" || base === "agents" ? path.dirname(dir) : dir
    return [path.join(root, "skill"), path.join(root, "skills")]
  }

  private id(input: string) {
    return input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
  }

  private title(input: string) {
    return input
      .split(/[-_]+/g)
      .filter((item) => item.length > 0)
      .map((item) => item[0]?.toUpperCase() + item.slice(1))
      .join(" ")
  }

  private section(input: string, name: string) {
    const match = input.match(new RegExp(`(^|\\n)##\\s+${name}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"))
    return match?.[2]?.trim()
  }

  private ref(input: unknown) {
    return typeof input === "string" && input.trim().length > 0
  }

  private unsafe(input: string) {
    return path.isAbsolute(input) || input.split(/[\\/]+/g).includes("..")
  }

  private instruction(dir: string, input: string) {
    const root = "${agent.root}/"
    if (input.startsWith(root)) return path.join(path.dirname(dir), input.slice(root.length))
    const local = "${agent.dir}/"
    if (input.startsWith(local)) return path.join(dir, input.slice(local.length))
    return path.join(dir, input)
  }

  private url(input: string) {
    if (this.unsafe(input)) return false
    try {
      const url = new URL(input)
      return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
    } catch {
      return true
    }
  }

  private async protocolFile(dir: string, file: string) {
    const local = path.join(dir, file)
    if (await this.exists(local)) return local
    return path.join(path.dirname(path.dirname(dir)), "protocol", file)
  }

  private async audit(input: { dir: string; source: "package" | "user"; meta: Schema.Meta }) {
    const meta = input.meta
    if (meta.logo?.uri && !this.url(meta.logo.uri)) {
      this.warn({
        dir: input.dir,
        source: input.source,
        field: "logo.uri",
        category: "metadata.logo",
        message: `unsupported logo URI '${meta.logo.uri}'`,
      })
    }

    await Promise.all(
      (meta.instructions?.files ?? []).map(async (file, index) => {
        if (this.unsafe(file.path)) {
          this.warn({
            dir: input.dir,
            source: input.source,
            field: `instructions.files.${index}.path`,
            category: "metadata.instructions",
            message: `instruction path '${file.path}' must stay within the agent directory`,
          })
        }
        if (!file.required) return
        try {
          await fs.access(this.instruction(input.dir, file.path))
        } catch {
          this.warn({
            dir: input.dir,
            source: input.source,
            field: `instructions.files.${index}.path`,
            category: "metadata.instructions",
            message: `required instruction path '${file.path}' was not found`,
          })
        }
      }),
    )

    if (meta.protocol?.file && this.unsafe(meta.protocol.file)) {
      this.warn({
        dir: input.dir,
        source: input.source,
        field: "protocol.file",
        category: "metadata.protocol",
        message: `protocol file '${meta.protocol.file}' must stay within the agent directory`,
      })
    }

    ;(["input", "output"] as const).forEach((side) => {
      meta.contracts?.[side].forEach((item, index) => {
        if (!("schema_ref" in item) || this.ref(item.schema_ref)) return
        this.warn({
          dir: input.dir,
          source: input.source,
          field: `contracts.${side}.${index}.schema_ref`,
          category: "metadata.contracts",
          message: `${side} contract schema_ref must be a non-empty string`,
        })
      })
    })

    meta.collaboration?.edges.forEach((edge, index) => {
      if (this.ref(edge.target)) return
      this.warn({
        dir: input.dir,
        source: input.source,
        field: `collaboration.edges.${index}.target`,
        category: "metadata.collaboration",
        message: "collaboration edge target must be a non-empty string",
      })
    })
  }

  private async loadSkills(dir: string, source: "package" | "user"): Promise<AgentTemplate[]> {
    const out: AgentTemplate[] = []
    for (const root of this.skillRoots(dir)) {
      try {
        await fs.access(root)
      } catch {
        continue
      }

      const files = (await Glob.scan("*/SKILL.md", { cwd: root, absolute: true })).sort()
      for (const file of files) {
        const parsed = await ConfigMarkdown.parse(file).catch((err) => {
          this.warn({ dir: path.dirname(file), source, message: `failed to parse legacy skill: ${String(err)}` })
          return undefined
        })
        if (!parsed) continue

        const raw = typeof parsed.data.name === "string" ? parsed.data.name : path.basename(path.dirname(file))
        const id = this.id(raw)
        if (!id) continue
        const desc =
          typeof parsed.data.description === "string" && parsed.data.description.trim()
            ? parsed.data.description.trim()
            : `Use this agent for tasks from the legacy ${raw} skill.`
        const role = this.section(parsed.content, "Role") ?? `You are the ${this.title(id)} agent converted from a legacy skill.`
        const rules = [this.section(parsed.content, "Workflow"), this.section(parsed.content, "Rules")]
          .filter((item): item is string => !!item)
          .join("\n\n")
        const meta = Schema.Meta.parse({
          id,
          name: this.title(id),
          kind: "skill",
          role: `You are the ${this.title(id)} agent converted from a legacy skill.`,
          description: desc,
          mode: "subagent",
          capability: {
            purpose: "legacy_skill",
            tags: ["skill", id],
            cost: "medium",
            writes: true,
          },
          permission_mode: "lax",
        })
        out.push({
          id,
          name: meta.name,
          dir: path.dirname(file),
          source,
          meta,
          identity: role,
          rules: rules || parsed.content.trim(),
        })
      }
    }
    return out
  }

  /**
   * Load a single agent template from a directory.
   */
  private async loadTemplate(
    agentDir: string,
    agentId: string,
    source: "package" | "user",
  ): Promise<Entry | undefined> {
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

      await this.audit({ dir: agentDir, source, meta: result.data })

      const template = {
        id: result.data.id,
        name: result.data.name,
        dir: agentDir,
        source,
        meta: result.data,
        identity: await this.read(identityPath, agentId, "identity.md"),
        rules: await this.read(rulesPath, agentId, "rules.md"),
        protocol: result.data.protocol
          ? {
              file: result.data.protocol.file,
              prompt: await this.read(await this.protocolFile(agentDir, result.data.protocol.file), agentId, result.data.protocol.file),
            }
          : undefined,
      }
      return { template, status: { dir: agentDir, source, id: template.id, valid: true, errors: [] } }
    } catch (err) {
      const msg =
        err instanceof SyntaxError
          ? `malformed JSON in meta.json for agent '${agentId}'`
          : `failed to read meta.json for agent '${agentId}'`
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

  private async exists(file: string) {
    try {
      await fs.access(file)
      return true
    } catch {
      return false
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
