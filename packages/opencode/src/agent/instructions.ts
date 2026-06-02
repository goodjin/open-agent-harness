import path from "path"
import { createHash } from "crypto"

export type InstructionFile = {
  path: string
  role?: string
  required?: boolean
}

export type InstructionContext = {
  files?: readonly InstructionFile[]
  meta?: {
    instructions?: {
      files?: readonly InstructionFile[]
    }
  }
  agentDir: string
  projectRoot: string
  workspaceRoot: string
  globalRulesPath: string
  userHome: string
  runDir: string
}

export type InstructionDiagnostic = {
  level: "error" | "warning"
  blocking: boolean
  code: "unknown_variable" | "path_escape" | "missing_required" | "missing_optional" | "read_error"
  message: string
}

export type InstructionRecord = {
  path: string
  resolved?: string
  role?: string
  required: boolean
  content?: string
  hash?: string
  diagnostics: InstructionDiagnostic[]
}

export type InstructionResult = {
  records: InstructionRecord[]
  diagnostics: InstructionDiagnostic[]
  blocking: boolean
}

const names = ["agent.dir", "project.root", "workspace.root", "global.rules", "user.home", "run.dir"] as const

export async function resolveInstructions(ctx: InstructionContext): Promise<InstructionResult> {
  const vars = {
    "agent.dir": ctx.agentDir,
    "project.root": ctx.projectRoot,
    "workspace.root": ctx.workspaceRoot,
    "global.rules": ctx.globalRulesPath,
    "user.home": ctx.userHome,
    "run.dir": ctx.runDir,
  } satisfies Record<(typeof names)[number], string>

  const roots = {
    "agent.dir": ctx.agentDir,
    "project.root": ctx.projectRoot,
    "workspace.root": ctx.workspaceRoot,
    "global.rules": path.dirname(ctx.globalRulesPath),
    "user.home": ctx.userHome,
    "run.dir": ctx.runDir,
  } satisfies Record<(typeof names)[number], string>

  const records = await Promise.all(
    (ctx.files ?? ctx.meta?.instructions?.files ?? []).map(async (file) => {
      const required = file.required ?? false
      const found = [...file.path.matchAll(/\$\{([^}]+)\}/g)].map((item) => item[1])
      const unknown = found.find((item) => !names.includes(item as (typeof names)[number]))
      if (unknown) {
        return {
          path: file.path,
          role: file.role,
          required,
          diagnostics: [diag("error", true, "unknown_variable", `Unknown instruction path variable: ${unknown}`)],
        } satisfies InstructionRecord
      }

      const first = found.find((item) => names.includes(item as (typeof names)[number])) as (typeof names)[number] | undefined
      const text = file.path.replace(/\$\{([^}]+)\}/g, (_, name: (typeof names)[number]) => vars[name])
      const resolved = path.resolve(first || path.isAbsolute(text) ? text : path.join(ctx.agentDir, text))
      const root = first ? roots[first] : ctx.agentDir

      if (escapes(resolved, root)) {
        return {
          path: file.path,
          resolved,
          role: file.role,
          required,
          diagnostics: [diag("error", true, "path_escape", "Instruction path escapes its variable root")],
        } satisfies InstructionRecord
      }

      const input = Bun.file(resolved)
      const exists = await input.exists()
      if (!exists) {
        return {
          path: file.path,
          resolved,
          role: file.role,
          required,
          diagnostics: [
            required
              ? diag("error", true, "missing_required", "Required instruction file is missing")
              : diag("warning", false, "missing_optional", "Optional instruction file is missing"),
          ],
        } satisfies InstructionRecord
      }

      const content = await input.text().catch(() => undefined)
      if (content === undefined) {
        return {
          path: file.path,
          resolved,
          role: file.role,
          required,
          diagnostics: [diag("error", true, "read_error", "Instruction file could not be read")],
        } satisfies InstructionRecord
      }

      return {
        path: file.path,
        resolved,
        role: file.role,
        required,
        content,
        hash: createHash("sha256").update(content).digest("hex"),
        diagnostics: [],
      } satisfies InstructionRecord
    }),
  )
  const diagnostics = records.flatMap((item) => item.diagnostics)
  return {
    records,
    diagnostics,
    blocking: diagnostics.some((item) => item.blocking),
  }
}

function diag(level: InstructionDiagnostic["level"], blocking: boolean, code: InstructionDiagnostic["code"], message: string) {
  return { level, blocking, code, message }
}

function escapes(file: string, root: string) {
  const rel = path.relative(path.resolve(root), path.resolve(file))
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}
