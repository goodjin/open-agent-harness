import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import { Capability } from "../../src/permission/capability"
import { PermissionNext } from "../../src/permission/next"
import { Policy } from "../../src/permission/policy"
import { SixDim } from "../../src/permission/six-dim"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"

// Helper to clean up pending permission requests
async function rejectAll(message?: string) {
  for (const req of await PermissionNext.list({ all: true })) {
    await PermissionNext.reply({
      requestID: req.id,
      reply: "reject",
      message,
    })
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("production six-dimensional matcher matches permission and pattern", () => {
  const cap = Capability.make("bash", "git status")
  const match = SixDim.match({ permission: "bash", pattern: "git *" }, cap)
  expect(match).toEqual({
    dimension: true,
    permission: true,
    pattern: true,
  })
  expect(SixDim.matches({ permission: "webfetch", pattern: "*" }, cap)).toBe(false)
})

test("production six-dimensional matcher does not cross explicit dimensions", () => {
  const cap = Capability.make("bash", "git status")
  expect(SixDim.matches({ dimension: "network", permission: "*", pattern: "*" }, cap)).toBe(false)
  expect(SixDim.matches({ dimension: "command", permission: "*", pattern: "*" }, cap)).toBe(true)
})

test("production six-dimensional matcher treats dimensionless wildcard as global", () => {
  expect(SixDim.matches({ permission: "*", pattern: "*" }, Capability.make("bash", "git status"))).toBe(true)
  expect(SixDim.matches({ permission: "*", pattern: "*" }, Capability.make("webfetch", "https://example.com"))).toBe(true)
})

test("policy dimension wildcard does not cross dimensions accidentally", () => {
  const policy = Policy.parse({
    rules: [{ dimension: "command", permission: "*", pattern: "*", action: "allow", source: "user" }],
  })
  expect(Policy.evaluate(policy, "bash", "git status").action).toBe("allow")
  expect(Policy.evaluate(policy, "webfetch", "https://example.com").action).toBe("ask")
})

// ============================================================================
// Tool Dimension Tests (VAL-PERM-004)
// ============================================================================
// Tool dimension permissions: edit, read, glob, grep, list, bash, task,
// webfetch, websearch, codesearch, lsp, etc.

test("tool dimension - edit permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // When edit is denied, ask should throw DeniedError
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_tool_edit"),
          permission: "edit",
          patterns: ["src/app.ts"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "edit", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)

      // When edit is allowed, ask should resolve
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_edit"),
        permission: "edit",
        patterns: ["src/app.ts"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - read permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_read"),
        permission: "read",
        patterns: ["/path/to/file.ts"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "read", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - glob permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_glob"),
        permission: "glob",
        patterns: ["**/*.ts"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "glob", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - grep permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_grep"),
        permission: "grep",
        patterns: ["TODO"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "grep", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - bash permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_bash"),
        permission: "bash",
        patterns: ["ls -la"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - task permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_task"),
        permission: "task",
        patterns: ["general"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "task", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - webfetch permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_webfetch"),
        permission: "webfetch",
        patterns: ["https://example.com"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "webfetch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - websearch permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_websearch"),
        permission: "websearch",
        patterns: ["opencode ai"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "websearch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - lsp permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_lsp"),
        permission: "lsp",
        patterns: ["typescript"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "lsp", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - list permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_list"),
        permission: "list",
        patterns: ["/path/to/dir"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "list", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("tool dimension - codesearch permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_tool_codesearch"),
        permission: "codesearch",
        patterns: ["github.com"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "codesearch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

// ============================================================================
// File Dimension Tests (VAL-PERM-005)
// ============================================================================
// File dimension uses glob patterns for edit/read operations

test("file dimension - external_directory with glob pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Allow access to specific directory glob
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_file_glob"),
        permission: "external_directory",
        patterns: ["/tmp/project/**"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "external_directory", pattern: "/tmp/project/**", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("file dimension - external_directory denied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_file_denied"),
          permission: "external_directory",
          patterns: ["/etc/passwd"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "external_directory", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("file dimension - wildcard pattern matches all", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_file_wildcard"),
        permission: "external_directory",
        patterns: ["/any/path/here"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "external_directory", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("file dimension - specific pattern takes precedence", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Last matching rule wins, so deny on specific path should override allow on wildcard
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_file_specific"),
          permission: "external_directory",
          patterns: ["/tmp/secret"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "external_directory", pattern: "*", action: "allow" },
            { permission: "external_directory", pattern: "/tmp/secret", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

// ============================================================================
// Command Dimension Tests (VAL-PERM-006)
// ============================================================================
// Command dimension uses bash command patterns

test("command dimension - bash command pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_cmd_bash"),
        permission: "bash",
        patterns: ["git status"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("command dimension - dangerous command denied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_cmd_danger"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("command dimension - git subcommand pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_cmd_git"),
        permission: "bash",
        patterns: ["git checkout main"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "git checkout *", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("command dimension - npm run pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_cmd_npm"),
        permission: "bash",
        patterns: ["npm run dev"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "npm run *", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

// ============================================================================
// Network Dimension Tests (VAL-PERM-007)
// ============================================================================
// Network dimension uses URL patterns for HTTP requests

test("network dimension - webfetch URL pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_net_fetch"),
        permission: "webfetch",
        patterns: ["https://api.github.com/*"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "webfetch", pattern: "https://api.github.com/*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("network dimension - webfetch wildcard domain", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_net_wildcard"),
        permission: "webfetch",
        patterns: ["https://*.example.com"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "webfetch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("network dimension - websearch URL pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_net_search"),
        permission: "websearch",
        patterns: ["https://www.google.com/search*"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "websearch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("network dimension - codesearch URL pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_net_code"),
        permission: "codesearch",
        patterns: ["https://github.com/search*"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "codesearch", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("network dimension - specific URL denied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Use a pattern that correctly matches - the URL path needs to match the wildcard
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_net_deny"),
          permission: "webfetch",
          patterns: ["https://api.evil.com/data"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "webfetch", pattern: "https://api.*", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

// ============================================================================
// Agent Dimension Tests (VAL-PERM-008)
// ============================================================================
// Agent dimension uses subagent_type patterns for task spawning

test("agent dimension - task with subagent_type pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_agent_task"),
        permission: "task",
        patterns: ["general"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "task", pattern: "general", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("agent dimension - task wildcard allows all subagents", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_agent_wildcard"),
        permission: "task",
        patterns: ["explore"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "task", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("agent dimension - specific subagent_type denied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_agent_deny"),
          permission: "task",
          patterns: ["compaction"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "task", pattern: "*", action: "allow" },
            { permission: "task", pattern: "compaction", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("agent dimension - task permission with multiple subagent types", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Should allow first subagent type
      const result1 = await PermissionNext.ask({
        sessionID: SessionID.make("session_agent_multi"),
        permission: "task",
        patterns: ["general"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "task", pattern: "general", action: "allow" },
          { permission: "task", pattern: "explore", action: "allow" },
        ],
      })
      expect(result1).toBeUndefined()
    },
  })
})

// ============================================================================
// Quota Dimension Tests (VAL-PERM-009)
// ============================================================================
// Quota dimension controls doom_loop permission for repeated failures

test("quota dimension - doom_loop permission", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // doom_loop should be ask by default in agent defaults
      const ruleset = PermissionNext.fromConfig({
        "*": "allow",
        doom_loop: "ask",
      })

      const result = PermissionNext.evaluate("doom_loop", "edit", ruleset)
      expect(result.action).toBe("ask")
    },
  })
})

test("quota dimension - doom_loop denied", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        PermissionNext.ask({
          sessionID: SessionID.make("session_quota_doom"),
          permission: "doom_loop",
          patterns: ["edit"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "doom_loop", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(PermissionNext.DeniedError)
    },
  })
})

test("quota dimension - doom_loop allowed", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_quota_allow"),
        permission: "doom_loop",
        patterns: ["edit"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "doom_loop", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("quota dimension - doom_loop with tool pattern", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await PermissionNext.ask({
        sessionID: SessionID.make("session_quota_pattern"),
        permission: "doom_loop",
        patterns: ["bash"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "doom_loop", pattern: "bash", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

// ============================================================================
// Integration Tests - All Dimensions Together
// ============================================================================

test("six dimensions - all tool permissions work independently", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tools = ["edit", "read", "glob", "grep", "list", "bash", "task", "webfetch", "websearch", "codesearch", "lsp"]

      for (const tool of tools) {
        const result = await PermissionNext.ask({
          sessionID: SessionID.make("session_all_tools"),
          permission: tool,
          patterns: ["test"],
          metadata: {},
          always: [],
          ruleset: [{ permission: tool, pattern: "*", action: "allow" }],
        })
        expect(result).toBeUndefined()
      }
    },
  })
})

test("six dimensions - permission evaluation uses last match wins", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Last matching rule should win
      const result = PermissionNext.evaluate("bash", "dangerous", [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "dangerous", action: "deny" },
      ])
      expect(result.action).toBe("deny")
    },
  })
})

test("six dimensions - wildcard permission matches all", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = PermissionNext.evaluate("any_permission", "any_pattern", [
        { permission: "*", pattern: "*", action: "deny" },
      ])
      expect(result.action).toBe("deny")
    },
  })
})

test("six dimensions - unknown permission returns ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = PermissionNext.evaluate("unknown_dimension", "unknown_pattern", [
        { permission: "bash", pattern: "*", action: "allow" },
      ])
      expect(result.action).toBe("ask")
    },
  })
})
