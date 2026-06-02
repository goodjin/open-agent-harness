import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { resetRegistry } from "../../src/agent/registry"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  resetRegistry()
  Config.global.reset()
  await Instance.disposeAll()
})

function meta(id: string, input: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    role: `${id} role`,
    description: `${id} description`,
    ...input,
  }
}

async function request(dir: string, url: string, init?: RequestInit) {
  const app = Server.createApp({})
  return await Instance.provide({
    directory: dir,
    fn: () =>
      app.request(url, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...init?.headers,
        },
      }),
  })
}

async function direct(dir: string, url: string, init?: RequestInit) {
  const app = Server.createApp({})
  return await app.request(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": dir,
      ...init?.headers,
    },
  })
}

describe("agent management routes", () => {
  test("ordinary agent list uses request directory as the runtime boundary", async () => {
    await using tmp = await tmpdir({ git: true })

    const response = await direct(tmp.path, "/agent")
    const body = (await response.json()) as { name: string }[]

    expect(response.status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
  })

  test("creates and updates project agent template files", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request(tmp.path, "/agent/manage", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        meta: meta("scribe", {
          workflow_mode: "manual",
          permission_mode: "custom",
          inherit_permissions: false,
          allowed_tools: ["read"],
          denied_tools: ["bash"],
          entry: {
            primary: true,
            delegable: false,
            mentionable: true,
            default: true,
            hidden: false,
          },
          capability: {
            purpose: "writing",
            tags: ["docs"],
            cost: "low",
            writes: true,
          },
          model_preference: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
          },
        }),
        identity: "Scribe identity",
        rules: "Scribe rules",
      }),
    })

    expect(created.status).toBe(200)
    const item = (await created.json()) as { source: string; identity: string; rules: string; meta: { id: string } }
    expect(item.source).toBe("project")
    expect(item.meta.id).toBe("scribe")
    expect(item.identity).toBe("Scribe identity")
    expect(item.rules).toBe("Scribe rules")

    const root = path.join(tmp.path, ".opencode", "agents", "scribe")
    expect(JSON.parse(await Bun.file(path.join(root, "meta.json")).text()).allowed_tools).toEqual(["read"])
    expect(await Bun.file(path.join(root, "identity.md")).text()).toBe("Scribe identity")
    expect(await Bun.file(path.join(root, "rules.md")).text()).toBe("Scribe rules")

    const updated = await request(tmp.path, "/agent/manage/scribe", {
      method: "PATCH",
      body: JSON.stringify({
        scope: "project",
        meta: meta("scribe", {
          description: "updated description",
          permission_mode: "lax",
        }),
        identity: "Updated identity",
        rules: "Updated rules",
      }),
    })

    expect(updated.status).toBe(200)
    const next = (await updated.json()) as {
      meta: { description: string; permission_mode: string }
      identity: string
      rules: string
    }
    expect(next.meta.description).toBe("updated description")
    expect(next.meta.permission_mode).toBe("lax")
    expect(next.identity).toBe("Updated identity")
    expect(next.rules).toBe("Updated rules")
  })

  test("round-trips RFC metadata through manage endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    const completion = {
      mode: "all",
      criteria: ["summary"],
      required_artifacts: ["report.md"],
      required_evidence: ["test output"],
      gates: [{ name: "typecheck" }],
      allow_partial: false,
    }
    const data = meta("metadata-agent", {
      schema_version: "agent.metadata.v1",
      agent_version: "2026.6.2",
      logo: {
        uri: "logo.svg",
        alt: "Metadata agent logo",
        theme: "auto",
        hash: "sha256-demo",
      },
      instructions: {
        files: [
          {
            path: "guide.md",
            role: "system",
            required: false,
          },
        ],
        model_messages: [
          {
            on: "start",
            position: "append",
            content: "Use the guide.",
          },
        ],
      },
      contracts: {
        input: [{ schema_ref: "schemas/input.json" }],
        output: [{ schema_ref: "schemas/output.json" }],
      },
      collaboration: {
        edges: [{ target: "reviewer", mode: "handoff" }],
        limits: { max_depth: 2 },
      },
      runtime_boundary: {
        resource_classes: ["filesystem"],
        actions: { read: ["workspace"] },
        network: { mode: "none" },
        data: { retention: "session" },
        approval: { required: true },
        rate_limits: { calls: 8 },
      },
      completion,
      observability: {
        traces: true,
        sample_rate: 1,
      },
      lifecycle: {
        owner: "agent-platform",
        deprecated: false,
      },
    })

    const created = await request(tmp.path, "/agent/manage", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        meta: data,
      }),
    })

    expect(created.status).toBe(200)
    const item = (await created.json()) as { meta: Record<string, unknown> }
    expect(item.meta).toMatchObject(data)

    const root = path.join(tmp.path, ".opencode", "agents", "metadata-agent")
    expect(JSON.parse(await Bun.file(path.join(root, "meta.json")).text())).toMatchObject(data)

    const list = (await (await request(tmp.path, "/agent/manage")).json()) as {
      id: string
      meta: Record<string, unknown>
    }[]
    expect(list.find((item) => item.id === "metadata-agent")?.meta).toMatchObject(data)

    const got = (await (await request(tmp.path, "/agent/manage/metadata-agent")).json()) as {
      meta: Record<string, unknown>
    }
    expect(got.meta).toMatchObject(data)

    const updated = await request(tmp.path, "/agent/manage/metadata-agent", {
      method: "PATCH",
      body: JSON.stringify({
        scope: "project",
        meta: {
          ...data,
          agent_version: "2026.6.3",
          completion: {
            ...completion,
            allow_partial: true,
          },
        },
      }),
    })

    expect(updated.status).toBe(200)
    const next = (await updated.json()) as {
      meta: {
        agent_version: string
        completion: { allow_partial: boolean }
      }
    }
    expect(next.meta.agent_version).toBe("2026.6.3")
    expect(next.meta.completion.allow_partial).toBe(true)
    expect(JSON.parse(await Bun.file(path.join(root, "meta.json")).text()).completion.allow_partial).toBe(true)
  })

  test("validate returns diagnostics instead of throwing", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request(tmp.path, "/agent/manage/validate", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        meta: meta("bad/slash"),
      }),
    })

    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      valid: boolean
      diagnostics: { level: string; field?: string; message: string }[]
    }
    expect(result.valid).toBe(false)
    expect(result.diagnostics.some((item) => item.field === "id")).toBe(true)
  })

  test("validate keeps nested RFC metadata diagnostic fields and categories", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request(tmp.path, "/agent/manage/validate", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        meta: meta("bad-metadata", {
          schema_version: "agent.metadata.v1",
          instructions: {
            files: [
              {
                path: 1,
              },
            ],
          },
        }),
      }),
    })

    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      valid: boolean
      diagnostics: { field?: string; category?: string }[]
    }
    expect(result.valid).toBe(false)
    expect(result.diagnostics.find((item) => item.field === "instructions.files.0.path")?.category).toBe(
      "metadata.instructions",
    )
  })

  test("validate reports create id collisions", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request(tmp.path, "/agent/manage/validate", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        action: "create",
        meta: meta("build"),
      }),
    })

    expect(response.status).toBe(200)
    const result = (await response.json()) as {
      valid: boolean
      diagnostics: { level: string; field?: string; message: string }[]
    }
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toContainEqual({
      level: "error",
      field: "id",
      message: "Agent already exists: build",
    })
  })

  test("manage exposes bundled package default when package default directory is absent", async () => {
    await using tmp = await tmpdir({ git: true })
    const src = path.join(import.meta.dir, "..", "..", "config", "agents", "default")
    const bak = path.join(path.dirname(src), `.default-${crypto.randomUUID()}`)

    await fs.rename(src, bak)
    resetRegistry()
    try {
      const list = (await (await request(tmp.path, "/agent/manage")).json()) as { id: string; source: string }[]
      expect(list.find((item) => item.id === "default")?.source).toBe("package")
      expect(list.find((item) => item.id === "frontend")?.source).toBe("package")

      const got = await request(tmp.path, "/agent/manage/default")
      expect(got.status).toBe(200)
      const item = (await got.json()) as { source: string; identity: string; rules: string }
      expect(item.source).toBe("package")
      expect(item.identity).toContain("default project coordinator")
      expect(item.rules).toContain("## Clarification")

      const updated = await request(tmp.path, "/agent/manage/default", {
        method: "PATCH",
        body: JSON.stringify({
          scope: "project",
          identity: "Project default identity",
        }),
      })
      expect(updated.status).toBe(200)
      const next = (await updated.json()) as { source: string; identity: string }
      expect(next.source).toBe("project")
      expect(next.identity).toBe("Project default identity")
      expect(await Bun.file(path.join(tmp.path, ".opencode", "agents", "default", "identity.md")).text()).toBe(
        "Project default identity",
      )

      const state = await request(tmp.path, "/agent/manage/default/state", {
        method: "PATCH",
        body: JSON.stringify({
          scope: "project",
          disabled: true,
        }),
      })
      expect(state.status).toBe(200)
      expect(
        JSON.parse(await Bun.file(path.join(tmp.path, ".opencode", "opencode.json")).text()).agent.default.disable,
      ).toBe(true)
    } finally {
      await fs.rename(bak, src).catch(async () => {
        if (!(await Bun.file(src).exists())) await fs.rename(bak, src)
      })
      resetRegistry()
    }
  })

  test("creates user agent template files", async () => {
    await using tmp = await tmpdir({ git: true })
    const id = `user-scope-${crypto.randomUUID().slice(0, 8)}`
    try {
      const response = await request(tmp.path, "/agent/manage", {
        method: "POST",
        body: JSON.stringify({
          scope: "user",
          meta: meta(id),
          identity: "User identity",
          rules: "User rules",
        }),
      })

      expect(response.status).toBe(200)
      const item = (await response.json()) as { source: string; identity: string; rules: string }
      expect(item.source).toBe("user")
      expect(item.identity).toBe("User identity")
      expect(item.rules).toBe("User rules")
      expect(await Bun.file(path.join(Global.Path.config, "agents", id, "identity.md")).text()).toBe("User identity")
    } finally {
      await fs.rm(path.join(Global.Path.config, "agents", id), { recursive: true, force: true })
    }
  })

  test("manage list shows disabled agent while ordinary agent list hides it", async () => {
    await using tmp = await tmpdir({ git: true })
    await request(tmp.path, "/agent/manage", {
      method: "POST",
      body: JSON.stringify({
        scope: "project",
        meta: meta("switchable"),
        identity: "Switchable identity",
        rules: "Switchable rules",
      }),
    })

    const before = (await (await request(tmp.path, "/agent")).json()) as { name: string }[]
    expect(before.map((item) => item.name)).toContain("switchable")

    const disabled = await request(tmp.path, "/agent/manage/switchable/state", {
      method: "PATCH",
      body: JSON.stringify({
        scope: "project",
        disabled: true,
      }),
    })
    expect(disabled.status).toBe(200)

    const manage = (await (await request(tmp.path, "/agent/manage")).json()) as { id: string; disabled: boolean }[]
    expect(manage.find((item) => item.id === "switchable")?.disabled).toBe(true)

    const hidden = (await (await request(tmp.path, "/agent")).json()) as { name: string }[]
    expect(hidden.map((item) => item.name)).not.toContain("switchable")

    const enabled = await request(tmp.path, "/agent/manage/switchable/state", {
      method: "PATCH",
      body: JSON.stringify({
        scope: "project",
        disabled: false,
      }),
    })
    expect(enabled.status).toBe(200)

    const shown = (await (await request(tmp.path, "/agent")).json()) as { name: string }[]
    expect(shown.map((item) => item.name)).toContain("switchable")
  })

  test("claude skills appear as skill-backed agents in ordinary and manage lists", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(Global.Path.home, ".claude", "skills", "reviewer")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      [
        "---",
        "name: skill-reviewer",
        "description: Reviews work from a Claude skill.",
        "---",
        "",
        "# Reviewer",
        "",
        "Review the work.",
        "",
      ].join("\n"),
    )
    resetRegistry()
    try {
      const agents = (await (await request(tmp.path, "/agent")).json()) as {
        name: string
        description?: string
        capability: { purpose: string }
      }[]
      expect(agents.find((item) => item.name === "skill-reviewer")).toMatchObject({
        description: "Reviews work from a Claude skill.",
        capability: { purpose: "legacy_skill" },
      })

      const manage = (await (await request(tmp.path, "/agent/manage")).json()) as {
        id: string
        kind: string
        source: string
        editable: boolean
      }[]
      expect(manage.find((item) => item.id === "skill-reviewer")).toMatchObject({
        kind: "skill",
        source: "user",
        editable: false,
      })
    } finally {
      await fs.rm(path.join(Global.Path.home, ".claude"), { recursive: true, force: true })
      resetRegistry()
    }
  })

  test("template identity and rules markdown are not loaded as legacy agents", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, ".opencode", "agents", "atlas")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "atlas",
        name: "Atlas",
        role: "Atlas role",
        description: "Atlas description",
      }),
    )
    await fs.writeFile(path.join(dir, "identity.md"), "# Identity")
    await fs.writeFile(path.join(dir, "rules.md"), "# Rules")
    resetRegistry()

    const agents = (await (await request(tmp.path, "/agent")).json()) as { name: string }[]

    expect(agents.map((item) => item.name)).toContain("atlas")
    expect(agents.map((item) => item.name)).not.toContain("atlas/identity")
    expect(agents.map((item) => item.name)).not.toContain("atlas/rules")
  })

  test("editing package agent writes project override", async () => {
    await using tmp = await tmpdir({ git: true })
    const original = await Bun.file(
      path.join(import.meta.dir, "..", "..", "config", "agents", "build", "identity.md"),
    ).text()
    const response = await request(tmp.path, "/agent/manage/build", {
      method: "PATCH",
      body: JSON.stringify({
        scope: "project",
        identity: "Project build identity",
      }),
    })

    expect(response.status).toBe(200)
    const item = (await response.json()) as { source: string; identity: string }
    expect(item.source).toBe("project")
    expect(item.identity).toBe("Project build identity")
    expect(await Bun.file(path.join(tmp.path, ".opencode", "agents", "build", "identity.md")).text()).toBe(
      "Project build identity",
    )
    expect(
      await Bun.file(path.join(import.meta.dir, "..", "..", "config", "agents", "build", "identity.md")).text(),
    ).toBe(original)

    await fs.rm(path.join(tmp.path, ".opencode", "agents", "build"), { recursive: true, force: true })
  })
})
