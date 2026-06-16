import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { WorkspaceID } from "../../src/control-plane/schema"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLog } from "../../src/session/log"
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
          { type: "waiting_child" as const, message: "waiting for child" },
          { type: "error" as const, message: "test error" },
          { type: "timeout" as const, message: "test timeout" },
          { type: "retry" as const, attempt: 1, message: "retry message", next: Date.now() + 2000 },
          { type: "interrupted" as const, prior: "running" as const, message: "process stopped" },
          { type: "user_completed" as const, message: "accepted by user" },
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

  test("records session status transition logs with reason", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-status-log"),
          fn: async () => {
            const session = await Session.create({})
            const sessionID = session.id
            const log = Promise.race([
              new Promise<SessionLog.Info>((resolve) => {
                const unsub = Bus.subscribe(SessionLog.Event.Created, (event) => {
                  const info = event.properties.info
                  if (info.sessionID !== sessionID) return
                  if (info.type !== "session.status.changed") return
                  if (info.data.to !== "waiting_permission") return
                  unsub()
                  resolve(info)
                })
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Timed out waiting for status log")), 1000),
              ),
            ])

            SessionStatus.set(sessionID, { type: "running" })
            SessionStatus.set(sessionID, { type: "waiting_permission" })

            const info = await log
            expect(info.data.from).toBe("running")
            expect(info.data.to).toBe("waiting_permission")
            expect(info.data.reason).toBe("Session status changed to waiting_permission.")
            await Session.remove(sessionID)
          },
        }),
    })
  })

  test("allows user-marked completion from unfinished and failed states", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-user-completed"),
          fn: async () => {
            const waiting = await Session.create({})
            SessionStatus.set(waiting.id, { type: "running" })
            SessionStatus.set(waiting.id, { type: "waiting_child", message: "waiting" })
            SessionStatus.set(
              waiting.id,
              { type: "user_completed", message: "good enough" },
              { reason: "User accepted partial result." },
            )
            expect(SessionStatus.get(waiting.id)).toEqual({ type: "user_completed", message: "good enough" })

            const failed = await Session.create({})
            SessionStatus.set(failed.id, { type: "failed", message: "tool failed" })
            SessionStatus.set(failed.id, { type: "user_completed", message: "handled outside the runtime" })
            expect(SessionStatus.get(failed.id).type).toBe("user_completed")

            await Session.remove(waiting.id)
            await Session.remove(failed.id)
          },
        }),
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

  test("running and completed sessions can wait for child sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const active = "test-session-waiting-child-active" as SessionID
        SessionStatus.set(active, { type: "running" })
        SessionStatus.set(active, { type: "waiting_child", message: "waiting" })
        expect(SessionStatus.get(active).type).toBe("waiting_child")

        const done = "test-session-waiting-child-completed" as SessionID
        SessionStatus.set(done, { type: "completed" })
        SessionStatus.set(done, { type: "waiting_child", message: "late child result" })
        expect(SessionStatus.get(done).type).toBe("waiting_child")
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

  test("running to timeout transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-timeout" as SessionID
        SessionStatus.set(sessionID, { type: "running" })

        let receivedStatus: SessionStatus.Info | undefined
        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "timeout", message: "operation timed out" })

        await new Promise((resolve) => setTimeout(resolve, 10))
        unsub()

        expect(receivedStatus?.type).toBe("timeout")
        expect(SessionStatus.get(sessionID)).toEqual({ type: "timeout", message: "operation timed out" })
      },
    })
  })

  test("timeout to waiting_user transition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-timeout-waiting-user" as SessionID
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "timeout", message: "timed out" })

        let receivedStatus: SessionStatus.Info | undefined
        const unsub = Bus.subscribe(SessionStatus.Event.Status, (event) => {
          receivedStatus = event.properties.status
        })

        SessionStatus.set(sessionID, { type: "waiting_user" })
        await new Promise((resolve) => setTimeout(resolve, 10))
        unsub()

        expect(receivedStatus?.type).toBe("waiting_user")
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

  test("timeout to idle transition (recovery)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-timeout-recovery" as SessionID
        SessionStatus.set(sessionID, { type: "running" })
        SessionStatus.set(sessionID, { type: "timeout", message: "timed out" })
        SessionStatus.set(sessionID, { type: "idle" })

        expect(SessionStatus.get(sessionID).type).toBe("idle")
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

  test("restores persisted status across instance restart", async () => {
    const sessionID = "test-session-restart" as SessionID
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        SessionStatus.set(sessionID, { type: "blocked", message: "needs user decision" })
        await SessionStatus.flush()
        expect(SessionStatus.get(sessionID)).toEqual({ type: "blocked", message: "needs user decision" })
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        await SessionStatus.restore()
        expect(SessionStatus.get(sessionID)).toEqual({ type: "blocked", message: "needs user decision" })
        SessionStatus.set(sessionID, { type: "idle" })
        await SessionStatus.flush()
      },
    })
  })

  test("restores completed status across instance restart", async () => {
    const sessionID = "test-session-completed-restart" as SessionID
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        SessionStatus.set(sessionID, { type: "completed" })
        await SessionStatus.flush()
        expect(SessionStatus.get(sessionID)).toEqual({ type: "completed" })
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        await SessionStatus.restore()
        expect(SessionStatus.get(sessionID)).toEqual({ type: "completed" })
        SessionStatus.set(sessionID, { type: "idle" })
        await SessionStatus.flush()
      },
    })
  })

  test("allows a completed session to enter rate limited for a new request", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-completed-rate-limited" as SessionID
        SessionStatus.set(sessionID, { type: "completed" })
        SessionStatus.set(sessionID, {
          type: "rate_limited",
          providerID: "p",
          modelID: "m",
          scope: "model",
          active: 1,
          limit: 1,
          queued: 1,
        })

        expect(SessionStatus.get(sessionID).type).toBe("rate_limited")
        SessionStatus.set(sessionID, { type: "idle" })
      },
    })
  })

  test("restores restart-lost active statuses as interrupted", async () => {
    const running = "test-session-running-restart" as SessionID
    const starting = "test-session-starting-restart" as SessionID
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        SessionStatus.set(running, { type: "running" })
        SessionStatus.set(starting, { type: "starting" })
        await SessionStatus.flush()
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const restored = await SessionStatus.restore()
        expect(restored[running]?.type).toBe("interrupted")
        expect(restored[starting]?.type).toBe("interrupted")
        expect(SessionStatus.get(running)).toEqual({
          type: "interrupted",
          prior: "running",
          message: "Session was running when the process stopped.",
        })
        expect(SessionStatus.get(starting)).toEqual({
          type: "interrupted",
          prior: "starting",
          message: "Session was starting when the process stopped.",
        })
        SessionStatus.set(running, { type: "idle" })
        SessionStatus.set(starting, { type: "idle" })
        await SessionStatus.flush()
      },
    })
  })

  test("restores queued rate limited and retry statuses for automatic continuation", async () => {
    const queued = "test-session-queued-restart" as SessionID
    const limited = "test-session-limited-restart" as SessionID
    const retry = "test-session-retry-restart" as SessionID
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        SessionStatus.set(queued, { type: "queued" })
        SessionStatus.set(limited, {
          type: "rate_limited",
          providerID: "p",
          modelID: "m",
          scope: "model",
          active: 1,
          limit: 1,
          queued: 1,
        })
        SessionStatus.set(retry, { type: "running" })
        SessionStatus.set(retry, { type: "retry", attempt: 1, message: "retry", next: Date.now() })
        await SessionStatus.flush()
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const restored = await SessionStatus.restore()
        expect(restored[queued]).toEqual({ type: "queued" })
        expect(restored[limited]?.type).toBe("rate_limited")
        expect(restored[retry]?.type).toBe("retry")
        SessionStatus.set(queued, { type: "idle" })
        SessionStatus.set(limited, { type: "idle" })
        SessionStatus.set(retry, { type: "idle" })
        await SessionStatus.flush()
      },
    })
  })

  test("marks only active statuses for automatic continuation", async () => {
    expect(SessionStatus.shouldContinue({ type: "running" })).toBe(true)
    expect(SessionStatus.shouldContinue({ type: "retry", attempt: 1, message: "rate limited", next: Date.now() })).toBe(true)
    expect(SessionStatus.shouldContinue({ type: "rate_limited", providerID: "p", modelID: "m", scope: "model", active: 1, limit: 1, queued: 1 })).toBe(true)
    expect(SessionStatus.shouldContinue({ type: "blocked", message: "needs input" })).toBe(false)
    expect(SessionStatus.shouldContinue({ type: "interrupted", prior: "running" })).toBe(false)
    expect(SessionStatus.shouldContinue({ type: "error", message: "quota exceeded" })).toBe(false)
    expect(SessionStatus.shouldContinue({ type: "waiting_permission" })).toBe(false)
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
