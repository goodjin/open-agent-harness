import { test, expect, describe } from "bun:test"
import type { IdentityContent } from "../../src/agent/identity"
import { parseIdentity } from "../../src/agent/identity"
import type { RulesContent } from "../../src/agent/rules"
import { parseRules } from "../../src/agent/rules"
import { AgentTemplateLoader } from "../../src/agent/loader"

describe("Identity Parser", () => {
  describe("parseIdentity", () => {
    test("returns empty structure for empty content", () => {
      const result = parseIdentity("")
      expect(result.markdown).toBe("")
      expect(result.role).toBe("")
      expect(result.responsibilities).toEqual([])
      expect(result.communication).toEqual([])
      expect(result.expertise).toEqual([])
    })

    test("preserves markdown for LLM consumption", () => {
      const content = `# Identity

## Role Definition

You are a helpful AI assistant.

## Core Responsibilities

1. **Test**: Test description`
      const result = parseIdentity(content)
      expect(result.markdown).toBe(content)
    })

    test("extracts role definition section", () => {
      const content = `# Identity

## Role Definition

You are a helpful AI assistant specialized in coding.

## Core Responsibilities

1. **Code**: Write code`
      const result = parseIdentity(content)
      expect(result.role).toContain("helpful AI assistant")
      expect(result.role).toContain("coding")
    })

    test("extracts core responsibilities as items", () => {
      const content = `## Core Responsibilities

1. **Code Assistance**: Write, edit, and review code
2. **Debugging**: Identify and fix bugs
3. **Testing**: Assist with writing tests`
      const result = parseIdentity(content)
      expect(result.responsibilities).toHaveLength(3)
      expect(result.responsibilities[0]).toBe("Code Assistance: Write, edit, and review code")
      expect(result.responsibilities[1]).toBe("Debugging: Identify and fix bugs")
      expect(result.responsibilities[2]).toBe("Testing: Assist with writing tests")
    })

    test("extracts communication style items", () => {
      const content = `## Communication Style

- Be clear and concise
- Explain your reasoning
- Ask clarifying questions`
      const result = parseIdentity(content)
      expect(result.communication).toHaveLength(3)
      expect(result.communication[0]).toBe("Be clear and concise")
    })

    test("extracts expertise areas", () => {
      const content = `## Expertise Areas

- Full-stack web development
- Backend systems and APIs
- Database design`
      const result = parseIdentity(content)
      expect(result.expertise).toHaveLength(3)
      expect(result.expertise[0]).toBe("Full-stack web development")
    })

    test("handles malformed content gracefully", () => {
      const content = "Just some random text without proper structure"
      const result = parseIdentity(content)
      expect(result.markdown).toBe(content)
      expect(result.role).toBe("")
      expect(result.responsibilities).toEqual([])
    })
  })

  describe("VAL-AGENT-009: identity.md parsing - core responsibilities", () => {
    test("default agent identity.md contains responsibilities section", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      const parsed = parseIdentity(defaultAgent!.identity)
      expect(parsed.responsibilities.length).toBeGreaterThan(0)
      expect(parsed.responsibilities.some((r) => r.includes("Code"))).toBe(true)
    })

    test("default agent identity.md has markdown structure preserved", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      // Markdown structure should be preserved
      expect(defaultAgent!.identity).toContain("# Identity")
      expect(defaultAgent!.identity).toContain("## Role Definition")
      expect(defaultAgent!.identity).toContain("## Core Responsibilities")
      expect(defaultAgent!.identity).toContain("**")
    })

    test("parsed identity shows responsibilities section", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      const parsed = parseIdentity(defaultAgent!.identity)
      expect(parsed.responsibilities.length).toBeGreaterThanOrEqual(5)
    })
  })
})

describe("Rules Parser", () => {
  describe("parseRules", () => {
    test("returns empty structure for empty content", () => {
      const result = parseRules("")
      expect(result.markdown).toBe("")
      expect(result.general).toEqual([])
      expect(result.codeModification).toEqual([])
      expect(result.permission).toEqual([])
      expect(result.errorHandling).toEqual([])
      expect(result.sessionManagement).toEqual([])
    })

    test("preserves markdown for LLM consumption", () => {
      const content = `# Behavioral Rules

## General Behavior

1. **Safety First**: Never execute destructive commands`
      const result = parseRules(content)
      expect(result.markdown).toBe(content)
    })

    test("extracts general behavior rules", () => {
      const content = `## General Behavior

1. **Safety First**: Never execute destructive commands
2. **最小权限**: Only request minimum permissions needed`
      const result = parseRules(content)
      expect(result.general).toHaveLength(2)
      expect(result.general[0]).toBe("Safety First: Never execute destructive commands")
      expect(result.general[1]).toBe("最小权限: Only request minimum permissions needed")
    })

    test("extracts code modification rules", () => {
      const content = `## Code Modification Rules

1. **备份原则**: Before making significant changes
2. **增量修改**: Make small, incremental changes`
      const result = parseRules(content)
      expect(result.codeModification).toHaveLength(2)
      expect(result.codeModification[0]).toBe("备份原则: Before making significant changes")
    })

    test("extracts permission handling rules", () => {
      const content = `## Permission Handling

1. **请求明确**: When asking for permission
2. **拒绝处理**: If permission is denied`
      const result = parseRules(content)
      expect(result.permission).toHaveLength(2)
    })

    test("extracts error handling rules", () => {
      const content = `## Error Handling

1. **优雅降级**: When encountering errors
2. **重试策略**: Implement appropriate retry logic`
      const result = parseRules(content)
      expect(result.errorHandling).toHaveLength(2)
    })

    test("extracts session management rules", () => {
      const content = `## Session Management

1. **状态保持**: Maintain conversation context
2. **资源清理**: Clean up temporary files`
      const result = parseRules(content)
      expect(result.sessionManagement).toHaveLength(2)
    })

    test("handles malformed content gracefully", () => {
      const content = "Just some random text without proper structure"
      const result = parseRules(content)
      expect(result.markdown).toBe(content)
      expect(result.general).toEqual([])
    })
  })

  describe("VAL-AGENT-011: rules.md parsing - constraint validation", () => {
    test("default agent rules.md contains constraint sections", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      const parsed = parseRules(defaultAgent!.rules)
      expect(parsed.general.length).toBeGreaterThan(0)
      expect(parsed.codeModification.length).toBeGreaterThan(0)
    })

    test("default agent rules.md has markdown structure preserved", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      // Markdown structure should be preserved
      expect(defaultAgent!.rules).toContain("# Behavioral Rules")
      expect(defaultAgent!.rules).toContain("## General Behavior")
      expect(defaultAgent!.rules).toContain("**")
    })

    test("parsed rules shows constraint sections", async () => {
      const loader = new AgentTemplateLoader()
      const agents = await loader.loadAll()
      const defaultAgent = agents.find((a) => a.id === "default")
      expect(defaultAgent).toBeDefined()

      const parsed = parseRules(defaultAgent!.rules)
      // Should have rules in multiple categories
      const totalRules = parsed.general.length + parsed.codeModification.length +
        parsed.permission.length + parsed.errorHandling.length + parsed.sessionManagement.length
      expect(totalRules).toBeGreaterThan(0)
    })
  })
})

describe("Integration with AgentTemplateLoader", () => {
  test("identity.md content is retrievable as markdown string", async () => {
    const loader = new AgentTemplateLoader()
    const agents = await loader.loadAll()
    const defaultAgent = agents.find((a) => a.id === "default")
    expect(defaultAgent).toBeDefined()

    // Content should be a non-empty string
    expect(typeof defaultAgent!.identity).toBe("string")
    expect(defaultAgent!.identity.length).toBeGreaterThan(0)
  })

  test("rules.md content is retrievable as markdown string", async () => {
    const loader = new AgentTemplateLoader()
    const agents = await loader.loadAll()
    const defaultAgent = agents.find((a) => a.id === "default")
    expect(defaultAgent).toBeDefined()

    // Content should be a non-empty string
    expect(typeof defaultAgent!.rules).toBe("string")
    expect(defaultAgent!.rules.length).toBeGreaterThan(0)
  })

  test("markdown structure is preserved in parsed content", async () => {
    const loader = new AgentTemplateLoader()
    const agents = await loader.loadAll()
    const defaultAgent = agents.find((a) => a.id === "default")
    expect(defaultAgent).toBeDefined()

    // Check that markdown formatting is preserved
    const identity = defaultAgent!.identity
    const rules = defaultAgent!.rules

    // Should contain markdown headers
    expect(identity).toMatch(/^#\s+\w+/m)
    expect(identity).toMatch(/##\s+\w+/m)

    // Should contain bold text (**)
    expect(identity).toContain("**")
    expect(rules).toContain("**")

    // Should contain list items
    expect(identity).toMatch(/\d+\.\s+\*\*/)
    expect(rules).toMatch(/\d+\.\s+\*\*/)
  })
})
