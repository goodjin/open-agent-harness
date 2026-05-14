import { test, expect, describe } from "bun:test"
import { AgentTemplate } from "../../src/agent/schema"

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
        expect(result.data.workflow_mode).toBe("auto")
        expect(result.data.allowed_tools).toEqual(["edit", "read", "glob", "grep", "bash"])
        expect(result.data.denied_tools).toEqual(["webfetch", "mcp"])
        expect(result.data.inherit_permissions).toBe(true)
        expect(result.data.permission_mode).toBe("strict")
      }
    })
  })
})
