import { describe, expect, test } from "bun:test"
import path from "path"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"

const projectRoot = path.join(__dirname, "../..")

describe("session state machine", () => {
  test("VAL-SESSION-001: Session states enum coverage", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Verify all 6 states are valid
        const states = [
          { type: "idle" as const },
          { type: "running" as const },
          { type: "waiting_permission" as const },
          { type: "waiting_user" as const },
          { type: "error" as const, message: "test error" },
          { type: "retry" as const, attempt: 1, message: "retry message", next: Date.now() + 2000 },
        ]

        for (const state of states) {
          const result = SessionStatus.Info.safeParse(state)
          expect(result.success).toBe(true)
        }
      },
    })
  })

  test("VAL-SESSION-002: Idle state initial transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        // New sessions should start in idle state
        const status = SessionStatus.get(sessionID)
        expect(status.type).toBe("idle")
      },
    })
  })

  test("VAL-SESSION-003: Idle to running transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "running" })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("running")
      },
    })
  })

  test("VAL-SESSION-004: Running to waiting_permission transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "running" })

        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "waiting_permission" })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("waiting_permission")
      },
    })
  })

  test("VAL-SESSION-005: Running to waiting_user transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "running" })

        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "waiting_user" })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("waiting_user")
      },
    })
  })

  test("allows nested permission and user waits", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-nested-wait" as SessionID
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "waiting_permission" })
        SessionStatus.set(sessionID, { type: "waiting_user" })
        expect(SessionStatus.get(sessionID).type).toBe("waiting_user")

        SessionStatus.set(sessionID, { type: "waiting_permission" })
        expect(SessionStatus.get(sessionID).type).toBe("waiting_permission")

        SessionStatus.set(sessionID, { type: "idle" })
      },
    })
  })

  test("VAL-SESSION-006: Running to error transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "running" })

        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "error", message: "test error" })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("error")
        if (receivedStatus?.type === "error") {
          expect(receivedStatus.message).toBe("test error")
        }
      },
    })
  })

  test("VAL-SESSION-007: Running to retry transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "running" })

        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        const nextTime = Date.now() + 2000
        SessionStatus.set(sessionID, { type: "retry", attempt: 1, message: "rate limited", next: nextTime })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("retry")
        if (receivedStatus?.type === "retry") {
          expect(receivedStatus.attempt).toBe(1)
          expect(receivedStatus.message).toBe("rate limited")
          expect(receivedStatus.next).toBe(nextTime)
        }
      },
    })
  })

  test("VAL-SESSION-008: Error to idle transition (recovery)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "error", message: "some error" })

        let eventCount = 0
        let receivedStatus: SessionStatus.Info | undefined

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "idle" })

        await new Promise((resolve) => setTimeout(resolve, 10))

        unsub()

        expect(eventCount).toBe(1)
        expect(receivedStatus?.type).toBe("idle")
      },
    })
  })

  test("VAL-SESSION-017: State transition atomicity", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        // No intermediate states should be visible
        const events: SessionStatus.Info[] = []

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          events.push(event.properties.status)
        })

        // Rapid transitions
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "waiting_permission" })
        SessionStatus.set(sessionID, { type: "idle" })

        await new Promise((resolve) => setTimeout(resolve, 50))

        unsub()

        // Should have exactly 3 events, not more
        expect(events.length).toBe(3)
        expect(events.map((e) => e.type)).toEqual(["running", "waiting_permission", "idle"])
      },
    })
  })

  test("VAL-SESSION-018: State transition event publishing", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        let eventCount = 0

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          eventCount++
          // Verify event structure
          expect(event.properties.sessionID).toBe(sessionID)
          expect(event.properties.status).toBeDefined()
        })

        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "waiting_permission" })
        SessionStatus.set(sessionID, { type: "idle" })

        await new Promise((resolve) => setTimeout(resolve, 50))

        unsub()

        expect(eventCount).toBe(3)
      },
    })
  })

  test("VAL-SESSION-019: Session lifecycle state completeness", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        const lifecycle: string[] = []

        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          lifecycle.push(event.properties.status.type)
        })

        // Complete lifecycle: idle -> running -> waiting_permission -> running -> idle
        SessionStatus.set(sessionID, { type: "idle" })
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "waiting_permission" })
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "idle" })

        await new Promise((resolve) => setTimeout(resolve, 50))

        unsub()

        expect(lifecycle).toEqual(["idle", "running", "waiting_permission", "running", "idle"])
      },
    })
  })

  test("retry state preserves attempt and message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        const nextTime = Date.now() + 5000
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "retry", attempt: 3, message: "rate limited", next: nextTime })

        const status = SessionStatus.get(sessionID)
        expect(status.type).toBe("retry")
        if (status.type === "retry") {
          expect(status.attempt).toBe(3)
          expect(status.message).toBe("rate limited")
          expect(status.next).toBe(nextTime)
        }
        SessionStatus.set(sessionID, { type: "idle" })
      },
    })
  })

  test("rejects invalid transitions with clear error", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-invalid" as SessionID
        expect(() =>
          SessionStatus.set(sessionID, { type: "retry", attempt: 1, message: "rate limited", next: Date.now() }),
        ).toThrow("Invalid session status transition: idle -> retry")
      },
    })
  })

  test("status is volatile across instance restart", async () => {
    const sessionID = "test-session-restart" as SessionID
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        SessionStatus.set(sessionID, { type: "running" })
        expect(SessionStatus.get(sessionID).type).toBe("running")
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(SessionStatus.get(sessionID).type).toBe("idle")
      },
    })
  })

  test("error state preserves message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, { type: "error", message: "context overflow" })

        const status = SessionStatus.get(sessionID)
        expect(status.type).toBe("error")
        if (status.type === "error") {
          expect(status.message).toBe("context overflow")
        }
      },
    })
  })

  test("list returns all session statuses", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        const otherID = "other-session" as SessionID
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(otherID, { type: "running" })

        const all = SessionStatus.list()
        expect(all[sessionID]?.type).toBe("running")
        expect(all[otherID]?.type).toBe("running")

        // Cleanup - idle removes entry from state
        SessionStatus.set(sessionID, { type: "idle" })
        SessionStatus.set(otherID, { type: "idle" })
      },
    })
  })
})
