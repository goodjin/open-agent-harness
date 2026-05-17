import { describe, afterEach, test, expect } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { PermissionID } from "../../src/permission/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

async function waitForPending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await PermissionNext.list({ all: true })
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return PermissionNext.list({ all: true })
}

// ============================================================================
// VAL-CROSS-006: Multiple agents maintain isolated permission contexts
// ============================================================================

describe("agent permission isolation - VAL-CROSS-006", () => {
  test("agent A grants do not affect agent B evaluation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Simulate Agent A granting "always" permission for bash
        const sessionA = SessionID.make("session_agent_a")

        // Agent A requests bash permission - it needs to ask (ruleset has ask for bash)
        const askAPromise = PermissionNext.ask({
          id: PermissionID.make("per_agent_a"),
          sessionID: sessionA,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: ["ls"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        await waitForPending(1)

        // Agent A approves with "always"
        await PermissionNext.reply({
          requestID: PermissionID.make("per_agent_a"),
          reply: "always",
        })

        // Wait for the ask to resolve
        await askAPromise.catch(() => {})

        // Now simulate Agent B requesting the same bash permission
        const sessionB = SessionID.make("session_agent_b")

        // Agent B has the same base rules (ask for bash), but no stored "always" from Agent A
        // The key insight: without the shared approved array, Agent B should NOT see Agent A's grants
        const askBPromise = PermissionNext.ask({
          id: PermissionID.make("per_agent_b"),
          sessionID: sessionB,
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        // Wait for pending request
        await waitForPending(1)

        // Since there's no stored permission and the ruleset says "ask", it should go to pending
        // It should NOT be automatically allowed just because Agent A said "always"
        const pending = await PermissionNext.list()
        expect(pending.length).toBe(1)
        expect(pending[0].sessionID).toBe(sessionB)

        // Clean up - reject Agent B's request
        await PermissionNext.reply({
          requestID: PermissionID.make("per_agent_b"),
          reply: "reject",
        })
        await askBPromise.catch(() => {})
      },
    })
  })

  test("switching agents preserves new agent's permission context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create a session with Agent A's permission context
        const sessionA = SessionID.make("session_a")

        // Agent A allows bash by default
        const resultA = await PermissionNext.ask({
          id: PermissionID.make("per_switch_a"),
          sessionID: sessionA,
          permission: "bash",
          patterns: ["echo hello"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
        })

        // Agent A's request should be allowed (returns undefined)
        expect(resultA).toBeUndefined()

        // Now switch to Agent B with different permissions
        const sessionB = SessionID.make("session_b")

        // Agent B denies bash by default
        const askB = PermissionNext.ask({
          id: PermissionID.make("per_switch_b"),
          sessionID: sessionB,
          permission: "bash",
          patterns: ["echo hello"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        })

        // Agent B's request should be denied (throw error)
        await expect(askB).rejects.toBeInstanceOf(PermissionNext.DeniedError)

        // The key point: Agent A's "allow" does not affect Agent B's "deny"
        // This verifies that agent permission contexts are isolated
      },
    })
  })

  test("no cross-agent permission leakage - different sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Session 1: User grants "always" for bash
        const session1 = SessionID.make("session_1")

        const ask1Promise = PermissionNext.ask({
          id: PermissionID.make("per_cross_1"),
          sessionID: session1,
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: ["pwd"],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        await waitForPending(1)

        await PermissionNext.reply({
          requestID: PermissionID.make("per_cross_1"),
          reply: "always",
        })

        await ask1Promise.catch(() => {})

        // Session 2: Different user/session, should NOT inherit Session 1's "always"
        const session2 = SessionID.make("session_2")

        const ask2Promise = PermissionNext.ask({
          id: PermissionID.make("per_cross_2"),
          sessionID: session2,
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })

        // Should go to pending, NOT be allowed by Session 1's "always"
        await waitForPending(1)

        const pending = await PermissionNext.list()
        expect(pending.length).toBe(1)
        expect(pending[0].sessionID).toBe(session2)

        // Clean up
        await PermissionNext.reply({
          requestID: PermissionID.make("per_cross_2"),
          reply: "reject",
        })
        await ask2Promise.catch(() => {})
      },
    })
  })
})
