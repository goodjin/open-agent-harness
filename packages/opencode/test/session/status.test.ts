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
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { Storage } from "../../src/storage/storage"

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

  test("persists current status in the session row and restores it as authoritative state", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-status-authority"),
          fn: async () => {
            const session = await Session.create({})

            SessionStatus.set(session.id, { type: "terminal_reply", message: "Need parent decision." })
            await SessionStatus.flush()

            const row = Database.use((db) =>
              db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get(),
            )
            expect(row?.status_class).toBe("terminal")
            expect(row?.status).toBe("terminal_reply")
            expect(row?.status_message).toBe("Need parent decision.")

            SessionStatus.set(session.id, { type: "idle" })
            await SessionStatus.flush()
            Database.use((db) =>
              db
                .update(SessionTable)
                .set({
                  status_class: "terminal",
                  status: "terminal_reply",
                  status_message: "Restored from DB.",
                  status_recoverable: true,
                  status_source: "runtime",
                  status_updated_at: Date.now(),
                })
                .where(eq(SessionTable.id, session.id))
                .run(),
            )

            await SessionStatus.restore()
            expect(SessionStatus.get(session.id)).toEqual({ type: "terminal_reply", message: "Restored from DB." })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("restores legacy active rows as idle instead of interrupted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-status-legacy-active"),
          fn: async () => {
            const session = await Session.create({})

            Database.use((db) =>
              db
                .update(SessionTable)
                .set({
                  status_class: "active",
                  status: "active",
                  status_message: null,
                  status_detail: null,
                  status_updated_at: Date.now(),
                  status_source: "runtime",
                })
                .where(eq(SessionTable.id, session.id))
                .run(),
            )

            const restored = await SessionStatus.restore()
            expect(restored[session.id]).toBeUndefined()
            expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })

            await Session.remove(session.id)
          },
        }),
    })
  })

  test("uses database rows over stale session status files", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-status-db-over-file"),
          fn: async () => {
            const session = await Session.create({})
            await Storage.write(["session_status", session.id], {
              sessionID: session.id,
              projectID: Instance.project.id,
              directory: Instance.directory,
              status: { type: "running" },
              time: Date.now(),
            })

            const restored = await SessionStatus.restore()
            expect(restored[session.id]).toBeUndefined()
            expect(SessionStatus.get(session.id)).toEqual({ type: "idle" })

            await Storage.remove(["session_status", session.id])
            await Session.remove(session.id)
          },
        }),
    })
  })

  test("does not write session status snapshot files", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("test-workspace-status-no-file"),
          fn: async () => {
            const session = await Session.create({})

            SessionStatus.set(session.id, { type: "running" })
            await SessionStatus.flush()

            const file = await Storage.read(["session_status", session.id]).catch(() => undefined)
            expect(file).toBeUndefined()

            SessionStatus.set(session.id, { type: "idle" })
            await SessionStatus.flush()
            await Session.remove(session.id)
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
    const session = await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        SessionStatus.set(session.id, { type: "blocked", message: "needs user decision" })
        await SessionStatus.flush()
        expect(SessionStatus.get(session.id)).toEqual({ type: "blocked", message: "needs user decision" })
        return session
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        await SessionStatus.restore()
        expect(SessionStatus.get(session.id)).toEqual({ type: "blocked", message: "needs user decision" })
        SessionStatus.set(session.id, { type: "idle" })
        await SessionStatus.flush()
        await Session.remove(session.id)
      },
    })
  })

  test("restores completed status across instance restart", async () => {
    const session = await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        SessionStatus.set(session.id, { type: "completed" })
        await SessionStatus.flush()
        expect(SessionStatus.get(session.id)).toEqual({ type: "completed" })
        return session
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        await SessionStatus.restore()
        expect(SessionStatus.get(session.id)).toEqual({ type: "completed" })
        SessionStatus.set(session.id, { type: "idle" })
        await SessionStatus.flush()
        await Session.remove(session.id)
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

  test("allows non archived stopped sessions to enter new request states", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const limited = {
          type: "rate_limited",
          providerID: "p",
          modelID: "m",
          scope: "model",
          active: 1,
          limit: 1,
          queued: 1,
        } satisfies SessionStatus.Info
        const states = [
          { type: "error", message: "provider error" },
          { type: "timeout", message: "timed out" },
          { type: "paused", message: "paused" },
          { type: "aborted", message: "aborted" },
          { type: "failed", message: "failed" },
          { type: "blocked", message: "blocked" },
          { type: "interrupted", prior: "running", message: "interrupted" },
          { type: "completed" },
          { type: "terminal_reply", message: "reply" },
          { type: "user_completed", message: "accepted" },
        ] satisfies SessionStatus.Info[]
        const next = [{ type: "queued" }, { type: "starting" }, { type: "running" }, limited] satisfies SessionStatus.Info[]

        for (const [idx, state] of states.entries()) {
          for (const [pos, status] of next.entries()) {
            const id = `test-session-stopped-continue-${idx}-${pos}` as SessionID
            SessionStatus.set(id, state)
            SessionStatus.set(id, status)
            expect(SessionStatus.get(id).type).toBe(status.type)
            SessionStatus.set(id, { type: "idle" })
          }
        }
      },
    })
  })

  test("keeps archived sessions from entering rate limited directly", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-archived-rate-limited" as SessionID
        SessionStatus.set(sessionID, { type: "archived" })
        expect(() =>
          SessionStatus.set(sessionID, {
            type: "rate_limited",
            providerID: "p",
            modelID: "m",
            scope: "model",
            active: 1,
            limit: 1,
            queued: 1,
          }),
        ).toThrow("Invalid session status transition: archived -> rate_limited")
        SessionStatus.set(sessionID, { type: "idle" })
      },
    })
  })

  test("restores restart-lost active statuses as interrupted", async () => {
    const ids = await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const running = await Session.create({})
        const starting = await Session.create({})
        SessionStatus.set(running.id, { type: "running" })
        SessionStatus.set(starting.id, { type: "starting" })
        await SessionStatus.flush()
        return { running: running.id, starting: starting.id }
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const restored = await SessionStatus.restore()
        expect(restored[ids.running]?.type).toBe("interrupted")
        expect(restored[ids.starting]?.type).toBe("interrupted")
        expect(SessionStatus.get(ids.running)).toEqual({
          type: "interrupted",
          prior: "running",
          message: "Session was running when the process stopped.",
        })
        expect(SessionStatus.get(ids.starting)).toEqual({
          type: "interrupted",
          prior: "starting",
          message: "Session was starting when the process stopped.",
        })
        SessionStatus.set(ids.running, { type: "idle" })
        SessionStatus.set(ids.starting, { type: "idle" })
        await SessionStatus.flush()
        await Session.remove(ids.running)
        await Session.remove(ids.starting)
      },
    })
  })

  test("restores queued rate limited and retry statuses for automatic continuation", async () => {
    const ids = await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const queued = await Session.create({})
        const limited = await Session.create({})
        const retry = await Session.create({})
        SessionStatus.set(queued.id, { type: "queued" })
        SessionStatus.set(limited.id, {
          type: "rate_limited",
          providerID: "p",
          modelID: "m",
          scope: "model",
          active: 1,
          limit: 1,
          queued: 1,
        })
        SessionStatus.set(retry.id, { type: "running" })
        SessionStatus.set(retry.id, { type: "retry", attempt: 1, message: "retry", next: Date.now() })
        await SessionStatus.flush()
        return { queued: queued.id, limited: limited.id, retry: retry.id }
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const restored = await SessionStatus.restore()
        expect(restored[ids.queued]).toEqual({ type: "queued" })
        expect(restored[ids.limited]?.type).toBe("rate_limited")
        expect(restored[ids.retry]?.type).toBe("retry")
        SessionStatus.set(ids.queued, { type: "idle" })
        SessionStatus.set(ids.limited, { type: "idle" })
        SessionStatus.set(ids.retry, { type: "idle" })
        await SessionStatus.flush()
        await Session.remove(ids.queued)
        await Session.remove(ids.limited)
        await Session.remove(ids.retry)
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
    expect(
      SessionStatus.shouldContinue({
        type: "error",
        message: "Provider blocked the model output",
        reason: "output_safety",
        recoverable: true,
      }),
    ).toBe(false)
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

  test("error state preserves recoverable output safety classification", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = "test-session-id" as SessionID
        SessionStatus.set(sessionID, {
          type: "error",
          message: "Provider blocked the model output",
          reason: "output_safety",
          recoverable: true,
        })

        const status = SessionStatus.get(sessionID)
        expect(status.type).toBe("error")
        if (status.type === "error") {
          expect(status.reason).toBe("output_safety")
          expect(status.recoverable).toBe(true)
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
