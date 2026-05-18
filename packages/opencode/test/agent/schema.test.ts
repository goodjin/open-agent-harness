import { test, expect, describe } from "bun:test"
import { AgentTemplate } from "../../src/agent/schema"

const root = new URL("./fixtures/schema/", import.meta.url)

async function meta(dir: string) {
  return await Bun.file(new URL(`${dir}/meta.json`, root)).json()
}

describe("AgentTemplate.Meta", () => {
  describe("required fields validation", () => {
    test("valid meta.json with all required fields passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "A coding assistant that helps write and refactor code",
        description: "Specialized agent for writing and editing code",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.id).toBe("coder")
        expect(result.data.name).toBe("Coder Agent")
        expect(result.data.role).toBe("A coding assistant that helps write and refactor code")
        expect(result.data.description).toBe("Specialized agent for writing and editing code")
      }
    })

    test("missing id fails validation", () => {
      const invalid = {
        name: "Coder Agent",
        role: "A coding assistant",
        description: "Description",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("missing name fails validation", () => {
      const invalid = {
        id: "coder",
        role: "A coding assistant",
        description: "Description",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("missing role fails validation", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        description: "Description",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("missing description fails validation", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "A coding assistant",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("empty strings for required fields fail validation", () => {
      const invalid = {
        id: "",
        name: "",
        role: "",
        description: "",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("whitespace-only strings for required fields fail validation", () => {
      const invalid = {
        id: " ",
        name: "\t",
        role: "\n",
        description: "  ",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("required strings are trimmed", () => {
      const result = AgentTemplate.Meta.safeParse({
        id: " coder ",
        name: " Coder Agent ",
        role: " coding ",
        description: " A coder agent ",
      })
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.data.id).toBe("coder")
      expect(result.data.name).toBe("Coder Agent")
      expect(result.data.role).toBe("coding")
      expect(result.data.description).toBe("A coder agent")
    })
  })

  describe("model_preference field validation", () => {
    test("valid model_preference passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        model_preference: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.model_preference?.providerID).toBe("anthropic")
        expect(result.data.model_preference?.modelID).toBe("claude-sonnet-4-20250514")
      }
    })

    test("model_preference without providerID fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        model_preference: {
          modelID: "claude-sonnet-4-20250514",
        },
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("model_preference without modelID fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        model_preference: {
          providerID: "anthropic",
        },
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("model_preference is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("model_preference validates against provider catalog when available", () => {
      const result = AgentTemplate.Meta.safeParse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        model_preference: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
      })
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(
        AgentTemplate.validateModel(result.data, {
          anthropic: ["claude-sonnet-4-20250514"],
        }),
      ).toEqual([])
      expect(
        AgentTemplate.validateModel(result.data, {
          openai: ["gpt-5"],
        }),
      ).toEqual(["Unknown provider: anthropic"])
      expect(
        AgentTemplate.validateModel(result.data, {
          anthropic: ["claude-opus-4-20250514"],
        }),
      ).toEqual(["Unknown model: anthropic/claude-sonnet-4-20250514"])
    })
  })

  describe("workflow_mode field validation", () => {
    test("valid workflow_mode 'auto' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "auto",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("valid workflow_mode 'manual' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "manual",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("valid workflow_mode 'supervision' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "supervision",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("invalid workflow_mode fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "invalid",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("workflow_mode is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.workflow_mode).toBe("auto")
      }
    })

    test("workflow_mode maps to consumable runtime behavior", () => {
      const auto = AgentTemplate.Meta.parse({
        id: "auto",
        name: "Auto",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "auto",
      })
      const manual = AgentTemplate.Meta.parse({
        id: "manual",
        name: "Manual",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "manual",
      })
      const review = AgentTemplate.Meta.parse({
        id: "review",
        name: "Review",
        role: "coding",
        description: "A coder agent",
        workflow_mode: "supervision",
      })

      expect(AgentTemplate.workflow(auto)).toEqual({
        autonomous: true,
        prompt: false,
        review_tools: false,
        review_state: false,
      })
      expect(AgentTemplate.workflow(manual)).toEqual({
        autonomous: false,
        prompt: true,
        review_tools: true,
        review_state: true,
      })
      expect(AgentTemplate.workflow(review)).toEqual({
        autonomous: true,
        prompt: false,
        review_tools: true,
        review_state: true,
      })
    })
  })

  describe("runner field validation", () => {
    test("valid runner values pass", () => {
      const base = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }

      expect(AgentTemplate.Meta.safeParse({ ...base, runner: "chat" }).success).toBe(true)
      expect(AgentTemplate.Meta.safeParse({ ...base, runner: "workflow" }).success).toBe(true)
    })

    test("invalid runner fails", () => {
      const result = AgentTemplate.Meta.safeParse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        runner: "batch",
      })

      expect(result.success).toBe(false)
    })

    test("runner defaults to chat", () => {
      const result = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      })

      expect(result.runner).toBe("chat")
    })
  })

  describe("allowed_tools and denied_tools field validation", () => {
    test("valid allowed_tools array passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        allowed_tools: ["edit", "read", "bash", "grep"],
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.allowed_tools).toEqual(["edit", "read", "bash", "grep"])
      }
    })

    test("valid denied_tools array passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        denied_tools: ["webfetch", "mcp"],
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.denied_tools).toEqual(["webfetch", "mcp"])
      }
    })

    test("both allowed_tools and denied_tools can be present", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        allowed_tools: ["edit", "read"],
        denied_tools: ["bash", "webfetch"],
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("empty allowed_tools array passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        allowed_tools: [],
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("non-array allowed_tools fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        allowed_tools: "edit",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("allowed_tools is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.allowed_tools).toEqual([])
      }
    })

    test("denied_tools is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.denied_tools).toEqual([])
      }
    })

    test("whitespace-only tools fail validation", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        allowed_tools: ["read", " "],
        denied_tools: ["\t"],
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })
  })

  describe("inherit_permissions field validation", () => {
    test("inherit_permissions true passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        inherit_permissions: true,
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.inherit_permissions).toBe(true)
      }
    })

    test("inherit_permissions false passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        inherit_permissions: false,
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.inherit_permissions).toBe(false)
      }
    })

    test("non-boolean inherit_permissions fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        inherit_permissions: "true",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("inherit_permissions is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.inherit_permissions).toBe(true)
      }
    })
  })

  describe("permission_mode field validation", () => {
    test("valid permission_mode 'strict' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        permission_mode: "strict",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("valid permission_mode 'lax' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        permission_mode: "lax",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("valid permission_mode 'custom' passes", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        permission_mode: "custom",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
    })

    test("invalid permission_mode fails", () => {
      const invalid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        permission_mode: "invalid",
      }
      const result = AgentTemplate.Meta.safeParse(invalid)
      expect(result.success).toBe(false)
    })

    test("permission_mode is optional", () => {
      const valid = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(valid)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.permission_mode).toBe("strict")
      }
    })

    test("permission_mode maps to consumable permission defaults", () => {
      const strict = AgentTemplate.Meta.parse({
        id: "strict",
        name: "Strict",
        role: "coding",
        description: "A coder agent",
        permission_mode: "strict",
        allowed_tools: ["read"],
        denied_tools: ["bash"],
      })
      const lax = AgentTemplate.Meta.parse({
        id: "lax",
        name: "Lax",
        role: "coding",
        description: "A coder agent",
        permission_mode: "lax",
        allowed_tools: ["read"],
        denied_tools: ["bash"],
      })
      const custom = AgentTemplate.Meta.parse({
        id: "custom",
        name: "Custom",
        role: "coding",
        description: "A coder agent",
        inherit_permissions: false,
        permission_mode: "custom",
        allowed_tools: ["read"],
        denied_tools: ["bash"],
      })

      expect(AgentTemplate.permission(strict)).toEqual({
        inherit: true,
        policy: "inherit",
        allowed_tools: [],
        denied_tools: ["bash"],
      })
      expect(AgentTemplate.permission(lax)).toEqual({
        inherit: true,
        policy: "allow",
        allowed_tools: [],
        denied_tools: ["bash"],
      })
      expect(AgentTemplate.permission(custom)).toEqual({
        inherit: false,
        policy: "custom",
        allowed_tools: ["read"],
        denied_tools: ["bash"],
      })
    })
  })

  describe("complete meta.json examples", () => {
    test("minimal meta.json passes", () => {
      const minimal = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }
      const result = AgentTemplate.Meta.safeParse(minimal)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual({
          id: "coder",
          name: "Coder Agent",
          role: "coding",
          description: "A coder agent",
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
          allowed_tools: [],
          denied_tools: [],
          inherit_permissions: true,
          permission_mode: "strict",
        })
      }
    })

    test("full meta.json with all optional fields passes", () => {
      const full = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent that writes and edits code",
        model_preference: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
        entry: {
          primary: false,
          delegable: true,
          mentionable: true,
          default: false,
          hidden: false,
        },
        capability: {
          purpose: "code_review",
          tags: ["review", "tests"],
          cost: "high",
          writes: false,
        },
        mode: "primary",
        runner: "workflow",
        workflow_mode: "auto",
        allowed_tools: ["edit", "read", "glob", "grep", "bash"],
        denied_tools: ["webfetch", "mcp"],
        inherit_permissions: true,
        permission_mode: "strict",
      }
      const result = AgentTemplate.Meta.safeParse(full)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.model_preference?.providerID).toBe("anthropic")
        expect(result.data.entry.primary).toBe(false)
        expect(result.data.entry.default).toBe(false)
        expect(result.data.capability.purpose).toBe("code_review")
        expect(result.data.capability.tags).toEqual(["review", "tests"])
        expect(result.data.capability.cost).toBe("high")
        expect(result.data.capability.writes).toBe(false)
        expect(result.data.mode).toBe("primary")
        expect(result.data.runner).toBe("workflow")
        expect(result.data.workflow_mode).toBe("auto")
        expect(result.data.allowed_tools).toEqual(["edit", "read", "glob", "grep", "bash"])
        expect(result.data.denied_tools).toEqual(["webfetch", "mcp"])
        expect(result.data.inherit_permissions).toBe(true)
        expect(result.data.permission_mode).toBe("strict")
      }
    })
  })

  describe("entry and capability fields", () => {
    test("legacy mode maps to entry defaults", () => {
      const base = {
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      }

      expect(AgentTemplate.Meta.parse({ ...base, mode: "primary" }).entry).toEqual({
        primary: true,
        delegable: true,
        mentionable: true,
        default: true,
        hidden: false,
      })
      expect(AgentTemplate.Meta.parse({ ...base, mode: "subagent" }).entry).toEqual({
        primary: false,
        delegable: true,
        mentionable: true,
        default: false,
        hidden: false,
      })
      expect(AgentTemplate.Meta.parse({ ...base, mode: "all" }).entry).toEqual({
        primary: true,
        delegable: true,
        mentionable: true,
        default: true,
        hidden: false,
      })
    })

    test("legacy primary mode remains primary when exposed", () => {
      const result = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        mode: "primary",
      })

      expect(result.entry).toEqual({
        primary: true,
        delegable: true,
        mentionable: true,
        default: true,
        hidden: false,
      })
      expect(AgentTemplate.mode(result)).toBe("primary")
    })

    test("explicit entry wins over legacy mode", () => {
      const result = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        mode: "subagent",
        entry: {
          primary: true,
          delegable: false,
          mentionable: false,
          default: true,
          hidden: true,
        },
      })

      expect(result.entry).toEqual({
        primary: true,
        delegable: false,
        mentionable: false,
        default: true,
        hidden: true,
      })
      expect(AgentTemplate.mode(result)).toBe("primary")
    })

    test("top-level hidden maps to entry hidden for legacy configs", () => {
      const result = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
        hidden: true,
      })

      expect(result.hidden).toBe(true)
      expect(result.entry.hidden).toBe(true)
    })

    test("invalid capability values fail", () => {
      expect(
        AgentTemplate.Meta.safeParse({
          id: "coder",
          name: "Coder Agent",
          role: "coding",
          description: "A coder agent",
          capability: {
            purpose: "",
            tags: ["review"],
            cost: "medium",
            writes: false,
          },
        }).success,
      ).toBe(false)
      expect(
        AgentTemplate.Meta.safeParse({
          id: "coder",
          name: "Coder Agent",
          role: "coding",
          description: "A coder agent",
          capability: {
            purpose: "review",
            tags: [" "],
            cost: "medium",
            writes: false,
          },
        }).success,
      ).toBe(false)
      expect(
        AgentTemplate.Meta.safeParse({
          id: "coder",
          name: "Coder Agent",
          role: "coding",
          description: "A coder agent",
          capability: {
            purpose: "review",
            tags: ["review"],
            cost: "extreme",
            writes: false,
          },
        }).success,
      ).toBe(false)
    })
  })

  describe("default package meta.json", () => {
    test("default agent parses with frozen defaults", async () => {
      const json = await Bun.file(new URL("../../config/agents/default/meta.json", import.meta.url)).json()
      const result = AgentTemplate.Meta.safeParse(json)
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(result.data.id).toBe("default")
      expect(result.data.workflow_mode).toBe("auto")
      expect(result.data.permission_mode).toBe("custom")
      expect(result.data.allowed_tools).toContain("edit")
      expect(AgentTemplate.validateTemplate({ dir: "default", meta: result.data })).toEqual([])
    })
  })

  describe("template-level validation", () => {
    test("directory name must match meta id", () => {
      const result = AgentTemplate.Meta.safeParse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      })
      expect(result.success).toBe(true)
      if (!result.success) return

      expect(AgentTemplate.validateTemplate({ dir: "coder", meta: result.data })).toEqual([])
      expect(AgentTemplate.validateTemplate({ dir: "/tmp/config/agents/coder", meta: result.data })).toEqual([])
      expect(AgentTemplate.validateTemplate({ dir: "/tmp/config/agents/coder/", meta: result.data })).toEqual([])
      expect(AgentTemplate.validateTemplate({ dir: "writer", meta: result.data })).toEqual(["Agent id 'coder' must match directory 'writer'"])
      expect(AgentTemplate.validateTemplate({ dir: "/tmp/config/agents/writer", meta: result.data })).toEqual(["Agent id 'coder' must match directory 'writer'"])
    })

    test("duplicate ids are deterministic", () => {
      const a = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent",
        role: "coding",
        description: "A coder agent",
      })
      const b = AgentTemplate.Meta.parse({
        id: "coder",
        name: "Coder Agent Copy",
        role: "coding",
        description: "A copied coder agent",
      })

      expect(
        AgentTemplate.validateRegistry([
          { dir: "coder", meta: a },
          { dir: "coder-copy", meta: b },
        ]),
      ).toEqual(["Duplicate agent id 'coder' in 'coder' and 'coder-copy'"])
    })
  })

  describe("fixture-based schema regression", () => {
    test("valid fixtures parse with expected defaults", async () => {
      const min = AgentTemplate.Meta.safeParse(await meta("valid-minimal"))
      const full = AgentTemplate.Meta.safeParse(await meta("valid-full"))

      expect(min.success).toBe(true)
      expect(full.success).toBe(true)
      if (!min.success || !full.success) return

      expect(min.data.workflow_mode).toBe("auto")
      expect(min.data.allowed_tools).toEqual([])
      expect(full.data.workflow_mode).toBe("supervision")
      expect(full.data.permission_mode).toBe("custom")
      expect(AgentTemplate.validateModel(full.data, { anthropic: { "claude-sonnet-4-20250514": true } })).toEqual([])
    })

    test("invalid fixtures fail schema parse", async () => {
      expect(AgentTemplate.Meta.safeParse(await meta("invalid-unknown-field")).success).toBe(false)
      expect(AgentTemplate.Meta.safeParse(await meta("invalid-model-field")).success).toBe(false)
    })

    test("registry fixtures catch mismatch and duplicate ids", async () => {
      const mismatch = AgentTemplate.Meta.parse(await meta("mismatch-dir"))
      const a = AgentTemplate.Meta.parse(await meta("duplicate-a"))
      const b = AgentTemplate.Meta.parse(await meta("duplicate-b"))

      expect(AgentTemplate.validateTemplate({ dir: "mismatch-dir", meta: mismatch })).toEqual(["Agent id 'different-id' must match directory 'mismatch-dir'"])
      expect(
        AgentTemplate.validateRegistry([
          { dir: "duplicate-a", meta: a },
          { dir: "duplicate-b", meta: b },
        ]),
      ).toEqual(["Duplicate agent id 'duplicate' in 'duplicate-a' and 'duplicate-b'"])
    })
  })
})
