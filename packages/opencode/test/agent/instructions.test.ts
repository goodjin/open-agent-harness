import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { resolveInstructions } from "../../src/agent/instructions"

describe("resolveInstructions", () => {
  async function root() {
    const dir = await fs.mkdtemp(path.join("/tmp", "agent-instructions-"))
    const agent = path.join(dir, "agents", "coder")
    const project = path.join(dir, "project")
    const workspace = path.join(dir, "workspace")
    const global = path.join(dir, "global", "rules.md")
    const home = path.join(dir, "home")
    const run = path.join(dir, "run")

    await Promise.all([agent, project, workspace, path.dirname(global), home, run].map((item) => fs.mkdir(item, { recursive: true })))

    return { dir, agent, project, workspace, global, home, run }
  }

  function ctx(input: Awaited<ReturnType<typeof root>>) {
    return {
      agentDir: input.agent,
      projectRoot: input.project,
      workspaceRoot: input.workspace,
      globalRulesPath: input.global,
      userHome: input.home,
      runDir: input.run,
    }
  }

  test("resolves templates and reads instruction content", async () => {
    const tmp = await root()
    try {
      await fs.writeFile(path.join(tmp.agent, "rules.md"), "agent rules")
      await fs.writeFile(tmp.global, "global rules")

      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [
          { path: "${agent.dir}/rules.md", role: "system", required: true },
          { path: "${global.rules}", role: "developer", required: false },
        ],
      })

      expect(result.diagnostics).toEqual([])
      expect(result.records).toEqual([
        {
          path: "${agent.dir}/rules.md",
          resolved: path.join(tmp.agent, "rules.md"),
          role: "system",
          required: true,
          content: "agent rules",
          hash: expect.any(String),
          diagnostics: [],
        },
        {
          path: "${global.rules}",
          resolved: tmp.global,
          role: "developer",
          required: false,
          content: "global rules",
          hash: expect.any(String),
          diagnostics: [],
        },
      ])
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("accepts agent meta instructions and resolves every supported variable", async () => {
    const tmp = await root()
    try {
      await Promise.all([
        fs.writeFile(path.join(tmp.project, "project.md"), "project"),
        fs.writeFile(path.join(tmp.workspace, "workspace.md"), "workspace"),
        fs.writeFile(path.join(tmp.home, "home.md"), "home"),
        fs.writeFile(path.join(tmp.run, "run.md"), "run"),
      ])

      const result = await resolveInstructions({
        ...ctx(tmp),
        meta: {
          instructions: {
            files: [
              { path: "${project.root}/project.md" },
              { path: "${workspace.root}/workspace.md" },
              { path: "${user.home}/home.md" },
              { path: "${run.dir}/run.md" },
            ],
          },
        },
      })

      expect(result.diagnostics).toEqual([])
      expect(result.records.map((item) => item.content)).toEqual(["project", "workspace", "home", "run"])
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("resolves relative paths from the agent directory", async () => {
    const tmp = await root()
    try {
      await fs.writeFile(path.join(tmp.agent, "local.md"), "local")

      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [{ path: "local.md", required: true }],
      })

      expect(result.diagnostics).toEqual([])
      expect(result.records[0].resolved).toBe(path.join(tmp.agent, "local.md"))
      expect(result.records[0].content).toBe("local")
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("marks missing required files as blocking errors", async () => {
    const tmp = await root()
    try {
      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [{ path: "${agent.dir}/missing.md", required: true }],
      })

      expect(result.blocking).toBe(true)
      expect(result.records[0].diagnostics).toEqual([
        {
          level: "error",
          blocking: true,
          code: "missing_required",
          message: "Required instruction file is missing",
        },
      ])
      expect(result.diagnostics).toEqual(result.records[0].diagnostics)
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("marks missing optional files as warnings", async () => {
    const tmp = await root()
    try {
      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [{ path: "${agent.dir}/optional.md", role: "user", required: false }],
      })

      expect(result.blocking).toBe(false)
      expect(result.records[0]).toEqual({
        path: "${agent.dir}/optional.md",
        resolved: path.join(tmp.agent, "optional.md"),
        role: "user",
        required: false,
        diagnostics: [
          {
            level: "warning",
            blocking: false,
            code: "missing_optional",
            message: "Optional instruction file is missing",
          },
        ],
      })
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("rejects unknown variables before reading files", async () => {
    const tmp = await root()
    try {
      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [{ path: "${agent.root}/rules.md", required: true }],
      })

      expect(result.blocking).toBe(true)
      expect(result.records[0]).toEqual({
        path: "${agent.root}/rules.md",
        role: undefined,
        required: true,
        diagnostics: [
          {
            level: "error",
            blocking: true,
            code: "unknown_variable",
            message: "Unknown instruction path variable: agent.root",
          },
        ],
      })
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })

  test("rejects paths that escape their variable root", async () => {
    const tmp = await root()
    try {
      const result = await resolveInstructions({
        ...ctx(tmp),
        files: [{ path: "${agent.dir}/../outside.md", required: true }],
      })

      expect(result.blocking).toBe(true)
      expect(result.records[0].resolved).toBe(path.join(tmp.agent, "..", "outside.md"))
      expect(result.records[0].diagnostics).toEqual([
        {
          level: "error",
          blocking: true,
          code: "path_escape",
          message: "Instruction path escapes its variable root",
        },
      ])
    } finally {
      await fs.rm(tmp.dir, { recursive: true, force: true })
    }
  })
})
