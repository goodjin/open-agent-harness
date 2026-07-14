import { describe, expect, test } from "bun:test"
import { symlink } from "fs/promises"
import path from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { AgentProtocol } from "../../src/protocol/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionAssignment } from "../../src/session/assignment"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionResult } from "../../src/session/result"
import { SessionRuns } from "../../src/session/runs"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { AssignmentTable, PartTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

describe("session runs", () => {
  test("projects a running delegated run from its verified assignment", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_running"),
          fn: async () => {
            const item = await delegation("run_delegation_running", "Implement backend\n\nKeep the API stable.")

            const listed = await SessionRuns.list(item.child.id)
            const saved = await SessionRuns.get(item.child.id, item.run)

            expect(listed).toHaveLength(1)
            expect(saved).toMatchObject({
              kind: "delegation",
              run_id: item.run,
              action_id: "backend",
              task: "Implement backend\n\nKeep the API stable.",
              status: "running",
              fallback: false,
              actions: [],
              documents: [],
            })
            expect(saved?.summary).toBeUndefined()
            expect(saved?.summary_source).toBeUndefined()
            expect(saved?.metrics).toEqual({
              actions: 0,
              internal_tool_calls: 0,
              direct_model_tool_calls: 0,
              model_visible_bytes: 0,
              raw_output_bytes: 0,
              duration_ms: 0,
            })
            expect(listed[0]).toEqual(saved!)
          },
        }),
    })
  })

  test("projects a canonical action result onto its delegated run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_result"),
          fn: async () => {
            const item = await delegation("run_delegation_result", "Implement backend\n\nPreserve compatibility.")
            const rec = await SessionResult.put({
              carrier: "action_result",
              status: "completed",
              satisfying: true,
              sessionID: item.child.id,
              parentSessionID: item.parent.id,
              childSessionID: item.child.id,
              runID: item.run,
              actionID: "backend",
              summary: "Untrusted stored summary",
              raw: {
                input: {
                  kind: "action_result",
                  role: "worker",
                  action_id: "backend",
                  status: "success",
                  result: "Backend implementation completed.",
                },
              },
            })
            await Session.setDslContext({
              sessionID: item.child.id,
              dsl_context: {
                protocol: { delegation: item.packet },
                result: { result_id: rec.id },
              },
            })

            const saved = await SessionRuns.get(item.child.id, item.run)
            expect(saved).toMatchObject({
              kind: "delegation",
              run_id: item.run,
              action_id: "backend",
              task: expect.stringContaining("Implement backend"),
              summary: "Backend implementation completed.",
              summary_source: "action_result",
              status: "completed",
              fallback: false,
              actions: [],
              documents: [],
            })
            expect((await SessionRuns.list(item.child.id))[0]).toEqual(saved!)
          },
        }),
    })
  })

  test("uses only the trusted summary field for each canonical carrier", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_carriers"),
          fn: async () => {
            const cases = [
              {
                run: "run_fallback_output",
                carrier: "fallback_summary" as const,
                raw: { output: "Fallback output" },
                summary: "Stored fallback summary",
                expected: "Fallback output",
                source: "fallback_summary",
                fallback: true,
              },
              {
                run: "run_fallback_summary",
                carrier: "fallback_summary" as const,
                raw: {},
                summary: "Stored fallback summary",
                expected: "Stored fallback summary",
                source: "fallback_summary",
                fallback: true,
              },
              {
                run: "run_protocol_message",
                carrier: "agent_protocol_output" as const,
                raw: { item: { message: "Protocol message", summary: "Protocol summary" }, output: "Output" },
                summary: "Stored summary",
                expected: "Protocol message",
                source: "protocol",
                fallback: false,
              },
              {
                run: "run_plain_output",
                carrier: "plain_text_result" as const,
                raw: { output: "Plain output" },
                summary: "Stored summary",
                expected: "Plain output",
                source: undefined,
                fallback: false,
              },
            ] as const
            for (const entry of cases) {
              const item = await delegation(entry.run, `Plan for ${entry.run}`)
              const rec = await SessionResult.put({
                carrier: entry.carrier,
                status: "completed",
                satisfying: true,
                sessionID: item.child.id,
                parentSessionID: item.parent.id,
                childSessionID: item.child.id,
                runID: item.run,
                actionID: "backend",
                summary: entry.summary,
                raw: entry.raw,
              })
              await resultref(item.child.id, item.packet, rec.id)

              const saved = await SessionRuns.get(item.child.id, item.run)
              expect(saved?.summary).toBe(entry.expected)
              expect(saved?.summary_source).toBe(entry.source)
              expect(saved?.fallback).toBe(entry.fallback)
            }
          },
        }),
    })
  })

  test("does not substitute action result metadata when result text is missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_empty_action"),
          fn: async () => {
            const item = await delegation("run_empty_action", "Implement backend")
            const rec = await SessionResult.put({
              carrier: "action_result",
              status: "completed",
              satisfying: true,
              sessionID: item.child.id,
              parentSessionID: item.parent.id,
              childSessionID: item.child.id,
              runID: item.run,
              actionID: "backend",
              summary: "Do not expose this summary",
              raw: { input: { action_id: "backend", status: "success", result: 42 } },
            })
            await resultref(item.child.id, item.packet, rec.id)

            const saved = await SessionRuns.get(item.child.id, item.run)
            expect(saved?.status).toBe("completed")
            expect(saved?.summary).toBeUndefined()
            expect(saved?.summary_source).toBeUndefined()
          },
        }),
    })
  })

  test("maps canonical terminal statuses onto delegated runs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_status"),
          fn: async () => {
            const cases = [
              ["terminal_reply", "blocked", false],
              ["failed", "failed", false],
              ["blocked", "blocked", false],
              ["waiting_user", "blocked", false],
              ["partial", "completed", true],
            ] as const
            for (const [status, expected, satisfying] of cases) {
              const item = await delegation(`run_${status}`, `Plan for ${status}`)
              const rec = await SessionResult.put({
                carrier: "plain_text_result",
                status,
                satisfying,
                sessionID: item.child.id,
                parentSessionID: item.parent.id,
                childSessionID: item.child.id,
                runID: item.run,
                actionID: "backend",
                raw: { output: `${status} output` },
              })
              await resultref(item.child.id, item.packet, rec.id)
              expect((await SessionRuns.get(item.child.id, item.run))?.status).toBe(expected)
            }
          },
        }),
    })
  })

  test("keeps the delegated run separate from an internal protocol run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_internal"),
          fn: async () => {
            const item = await delegation("run_parent", "Implement backend")
            const rec = await SessionResult.put({
              carrier: "fallback_summary",
              status: "completed",
              satisfying: true,
              sessionID: item.child.id,
              parentSessionID: item.parent.id,
              childSessionID: item.child.id,
              runID: item.run,
              actionID: "backend",
              raw: { output: "Overall delegated result" },
            })
            await resultref(item.child.id, item.packet, rec.id)
            const internal = result("run_internal")
            await Storage.write(["session_protocol_run", item.child.id, internal.run_id], internal)

            const listed = await SessionRuns.list(item.child.id)
            const outer = listed.find((run) => run.run_id === item.run)
            const inner = listed.find((run) => run.run_id === internal.run_id)
            expect(listed).toHaveLength(2)
            expect(outer?.kind).toBe("delegation")
            expect(outer?.summary).toBe("Overall delegated result")
            expect(inner?.kind).toBe("protocol")
            expect(inner?.summary).toBeUndefined()
            expect(await SessionRuns.get(item.child.id, item.run)).toEqual(outer)
            expect(await SessionRuns.get(item.child.id, internal.run_id)).toEqual(inner)
          },
        }),
    })
  })

  test("rejects mismatched canonical result identities without leaking summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_result_security"),
          fn: async () => {
            const fields = ["missing", "parent", "child", "run", "action"] as const
            for (const field of fields) {
              const item = await delegation(`run_result_${field}`, `Private plan ${field}`)
              if (field === "missing") {
                await resultref(item.child.id, item.packet, "result_missing")
              } else {
                const other = await Session.create({})
                const rec = await SessionResult.put({
                  carrier: "fallback_summary",
                  status: "completed",
                  satisfying: true,
                  sessionID: item.child.id,
                  parentSessionID: field === "parent" ? other.id : item.parent.id,
                  childSessionID: field === "child" ? other.id : item.child.id,
                  runID: field === "run" ? "run_other" : item.run,
                  actionID: field === "action" ? "other" : "backend",
                  raw: { output: `Secret ${field}` },
                })
                await resultref(item.child.id, item.packet, rec.id)
              }
              const saved = await SessionRuns.get(item.child.id, item.run)
              expect(saved?.status).toBe("running")
              expect(saved?.summary).toBeUndefined()
            }
          },
        }),
    })
  })

  test("falls back to the delegation title when assignment associations do not match", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_assignment_security"),
          fn: async () => {
            const fields = ["session_id", "source_session_id", "source_run_id", "source_action_id"] as const
            for (const field of fields) {
              const item = await delegation(`run_assignment_${field}`, `Secret assignment plan ${field}`)
              const assignment = await SessionAssignment.bySource({
                sessionID: item.parent.id,
                runID: item.run,
                actionID: "backend",
              })
              Database.use((db) =>
                db
                  .update(AssignmentTable)
                  .set({
                    [field]: field === "session_id" ? item.parent.id : field === "source_session_id" ? item.child.id : "other",
                  })
                  .where(eq(AssignmentTable.id, assignment!.id))
                  .run(),
              )

              const saved = await SessionRuns.get(item.child.id, item.run)
              expect(saved?.task).toBe("Backend task")
              expect(saved?.task).not.toContain("Secret assignment plan")
            }
          },
        }),
    })
  })

  test("does not project ordinary or malformed delegation sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_delegation_packet_security"),
          fn: async () => {
            const ordinary = await Session.create({})
            expect(await SessionRuns.list(ordinary.id)).toEqual([])

            const fields = ["type", "parent_session_id", "child_session_id"] as const
            for (const field of fields) {
              const item = await delegation(`run_packet_${field}`, `Plan ${field}`)
              await Session.setDslContext({
                sessionID: item.child.id,
                dsl_context: {
                  protocol: {
                    delegation: {
                      ...item.packet,
                      [field]: field === "type" ? "agent.delegation.fake" : ordinary.id,
                    },
                  },
                },
              })
              expect(await SessionRuns.list(item.child.id)).toEqual([])
              expect(await SessionRuns.get(item.child.id, item.run)).toBeUndefined()
            }
          },
        }),
    })
  })

  test("maps executor summary to execution summary without exposing a model outcome", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_summary"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_summary")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)

            const saved = await SessionRuns.get(session.id, run.run_id)
            expect(saved?.execution_summary).toBe("Completed")
            expect(saved?.summary).toBeUndefined()
          },
        }),
    })
  })

  test("stores a protocol model outcome for list and get", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_outcome"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_outcome")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)

            await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "  User-facing result  ",
              messageID: "msg_outcome",
            })

            const listed = (await SessionRuns.list(session.id))[0]
            const saved = await SessionRuns.get(session.id, run.run_id)
            expect(listed?.summary).toBe("User-facing result")
            expect(listed?.summary_source).toBe("protocol")
            expect(saved?.summary).toBe("User-facing result")
            expect(saved?.summary_source).toBe("protocol")
          },
        }),
    })
  })

  test("lists completed outcomes without hydrating legacy history", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_skip_history"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_skip_history")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "Stored result",
              messageID: "msg_stored_result",
            })
            const msg = await reply(session.id, run.run_id, "Broken history", "turn")
            Database.use((db) =>
              db
                .update(PartTable)
                .set({
                  data: {
                    type: "text",
                    text: 1,
                    metadata: { kind: "protocol_response" },
                  } as unknown as typeof PartTable.$inferInsert.data,
                })
                .where(eq(PartTable.id, msg.part))
                .run(),
            )

            const runs = await SessionRuns.list(session.id)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.summary).toBe("Stored result")
          },
        }),
    })
  })

  test("rejects outcomes for missing protocol runs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_missing"),
          fn: async () => {
            const session = await Session.create({})
            expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: "run_missing",
                summary: "Result",
                messageID: "msg_missing",
              }),
            ).rejects.toThrow("Protocol run not found")
          },
        }),
    })
  })

  test("rejects empty protocol outcomes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_empty"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_empty")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "   ",
                messageID: "msg_empty",
              }),
            ).rejects.toThrow()
          },
        }),
    })
  })

  test("keeps the first outcome and rejects a different message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_idempotent"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_idempotent")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "First result",
              messageID: "msg_first",
            })
            expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "   ",
                messageID: "msg_first",
              }),
            ).rejects.toThrow()
            const same = await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "Late duplicate",
              messageID: "msg_first",
            })
            expect(same.summary).toBe("First result")
            const equivalent = await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "  First result  ",
              messageID: "msg_equivalent",
            })
            expect(equivalent.message_id).toBe("msg_first")
            expect(equivalent.completed_at).toBe(same.completed_at)
            expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "Late result",
                messageID: "msg_late",
              }),
            ).rejects.toThrow("Run outcome already exists")
            expect((await SessionRuns.get(session.id, run.run_id))?.summary).toBe("First result")
          },
        }),
    })
  })

  test("allows only one concurrent outcome writer", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_concurrent"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_concurrent")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const writes = await Promise.allSettled([
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "First concurrent result",
                messageID: "msg_concurrent_first",
              }),
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "Second concurrent result",
                messageID: "msg_concurrent_second",
              }),
            ])
            const done = writes.filter((item) => item.status === "fulfilled")
            expect(done).toHaveLength(1)
            expect(writes.filter((item) => item.status === "rejected")).toHaveLength(1)
            const winner = done[0]?.status === "fulfilled" ? done[0].value.summary : undefined
            expect((await SessionRuns.get(session.id, run.run_id))?.summary).toBe(winner)
          },
        }),
    })
  })

  test("allows concurrent equivalent outcome writers without overwriting the winner", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_concurrent_equivalent"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_concurrent_equivalent")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const writes = await Promise.allSettled([
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "Equivalent result",
                messageID: "msg_equivalent_first",
              }),
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: " Equivalent result ",
                messageID: "msg_equivalent_second",
              }),
            ])
            expect(writes.every((item) => item.status === "fulfilled")).toBe(true)
            const stored = await SessionRuns.get(session.id, run.run_id)
            expect(stored?.summary).toBe("Equivalent result")
            const outcomes = writes.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []))
            expect(new Set(outcomes.map((item) => item.message_id)).size).toBe(1)
            expect(new Set(outcomes.map((item) => item.completed_at)).size).toBe(1)
          },
        }),
    })
  })

  test("gets one run without reading unrelated corrupted runs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_targeted_get"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_targeted")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await Storage.write(["session_protocol_run", session.id, "run_corrupted"], { invalid: true })

            const saved = await SessionRuns.get(session.id, run.run_id)
            expect(saved?.run_id).toBe(run.run_id)
            expect(saved?.execution_summary).toBe("Completed")
          },
        }),
    })
  })

  test("rejects malformed outcomes without overwriting them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_malformed_outcome"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_malformed_outcome")
            const key = ["session_protocol_run_outcome", session.id, run.run_id]
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await Storage.write(key, { invalid: true })

            await expect(SessionRuns.get(session.id, run.run_id)).rejects.toThrow()
            await expect(SessionRuns.list(session.id)).rejects.toThrow()
            await expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "Replacement result",
                messageID: "msg_replacement",
              }),
            ).rejects.toThrow()
            expect(await Storage.read<{ invalid: boolean }>(key)).toEqual({ invalid: true })
          },
        }),
    })
  })

  test("rejects outcomes whose run id does not match their storage key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_mismatched_outcome"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_mismatched_outcome")
            const key = ["session_protocol_run_outcome", session.id, run.run_id]
            const outcome = {
              run_id: "run_other",
              summary: "Wrong result",
              message_id: "msg_wrong",
              completed_at: Date.now(),
            }
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await Storage.write(key, outcome)

            await expect(SessionRuns.get(session.id, run.run_id)).rejects.toThrow("Run outcome mismatch")
            await expect(SessionRuns.list(session.id)).rejects.toThrow("Run outcome mismatch")
            await expect(
              SessionRuns.finish({
                sessionID: session.id,
                runID: run.run_id,
                summary: "Wrong result",
                messageID: "msg_wrong",
              }),
            ).rejects.toThrow("Run outcome mismatch")
            expect(await Storage.read<typeof outcome>(key)).toEqual(outcome)
          },
        }),
    })
  })

  test("lists protocol runs with task content and planning documents", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_runs"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_docs")
            run.actions[0]!.input = { prompt: "Implement backend", task: "Ignored task" }
            run.actions.push({
              ...run.actions[0]!,
              id: "review",
              title: "Review task",
              input: { files: ["backend.ts"] },
            })
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const dir = path.join(tmp.path, ".harness", "sessions", session.id, "runs", run.run_id)
            await Bun.write(path.join(dir, "requirements", "backend.md"), "# Backend requirement\n")
            await Bun.write(path.join(dir, "manifest.md"), "# Manifest\n")

            const runs = await SessionRuns.list(session.id)
            expect(runs).toHaveLength(1)
            expect(runs[0]?.actions[0]?.input).toEqual({ prompt: "Implement backend", task: "Ignored task" })
            expect(runs[0]?.task).toContain("Planning run")
            expect(runs[0]?.task).toContain("## Backend task\n\nImplement backend")
            expect(runs[0]?.task).toContain('## Review task\n\n{\n  "files": [')
            expect(runs[0]?.documents.map((item) => item.path)).toEqual(["manifest.md", "requirements/backend.md"])
            expect((await SessionRuns.read(session.id, run.run_id, "requirements/backend.md"))?.body).toContain(
              "Backend requirement",
            )
          },
        }),
    })
  })

  test("includes the current running protocol projection", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_running_run"),
          fn: async () => {
            const session = await Session.create({})
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  current: "run_active",
                  runs: [
                    {
                      runID: "run_active",
                      title: "Active planning",
                      status: "running",
                      actions: [
                        {
                          id: "frontend",
                          title: "Frontend task",
                          operation: "frontend",
                          executor: { type: "agent", target: "frontend" },
                          input: { prompt: "Build Runs UI" },
                          depends_on: [],
                          status: "pending",
                          summary: "",
                          tool_call_ids: [],
                          duration_ms: 0,
                          time: { started: 10 },
                        },
                      ],
                      time: { started: 10 },
                      metrics: {
                        actions: 1,
                        internal_tool_calls: 0,
                        direct_model_tool_calls: 0,
                        model_visible_bytes: 0,
                        raw_output_bytes: 0,
                        duration_ms: 0,
                      },
                    },
                  ],
                },
              },
            })

            const runs = await SessionRuns.list(session.id)
            expect(runs[0]?.run_id).toBe("run_active")
            expect(runs[0]?.status).toBe("running")
            expect(runs[0]?.actions[0]?.input).toEqual({ prompt: "Build Runs UI" })
            expect(runs[0]?.summary).toBeUndefined()
            expect((await SessionRuns.get(session.id, "run_active"))?.status).toBe("running")
          },
        }),
    })
  })

  test("merges the latest protocol projection with stored execution data", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_projected_run"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_projected", "blocked")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            await SessionRuns.finish({
              sessionID: session.id,
              runID: run.run_id,
              summary: "Confirmed result",
              messageID: "msg_projected",
            })
            await Session.setDslContext({
              sessionID: session.id,
              dsl_context: {
                protocol: {
                  runs: [
                    {
                      runID: run.run_id,
                      title: "Projected planning",
                      status: "completed",
                      actions: [{ ...run.actions[0], title: "Projected backend", status: "completed" }],
                      time: { started: run.time.started, completed: run.time.started + 2 },
                      metrics: { ...run.metrics, duration_ms: 999 },
                    },
                  ],
                },
              },
            })

            const listed = (await SessionRuns.list(session.id))[0]
            const saved = await SessionRuns.get(session.id, run.run_id)
            for (const item of [listed, saved]) {
              expect(item?.status).toBe("completed")
              expect(item?.actions[0]?.title).toBe("Projected backend")
              expect(item?.metrics.duration_ms).toBe(1)
              expect(item?.execution_summary).toBe("Completed")
              expect(item?.summary).toBe("Confirmed result")
            }
          },
        }),
    })
  })

  test("recovers only a trusted current-session protocol response", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_history"),
          fn: async () => {
            const session = await Session.create({})
            const other = await Session.create({})
            const trusted = result("run_trusted")
            const delegated = result("run_delegated")
            const forged = result("run_forged")
            const internal = result("run_internal")
            const source = result("run_source")
            await Storage.write(["session_protocol_run", session.id, trusted.run_id], trusted)
            await Storage.write(["session_protocol_run", session.id, delegated.run_id], delegated)
            await Storage.write(["session_protocol_run", session.id, forged.run_id], forged)
            await Storage.write(["session_protocol_run", session.id, internal.run_id], internal)
            await Storage.write(["session_protocol_run", session.id, source.run_id], source)
            await reply(session.id, trusted.run_id, "Trusted historical result", "turn")
            await Bun.sleep(2)
            await reply(session.id, trusted.run_id, "New trusted historical result", "turn")
            await reply(session.id, delegated.run_id, "Delegated historical result", "delegation")
            await reply(session.id, forged.run_id, "Forged result", "plain")
            await reply(session.id, internal.run_id, "Internal-only result", "internal")
            await reply(session.id, source.run_id, "Source-only result", "source")
            await reply(other.id, trusted.run_id, "Other session result", "turn")

            const runs = await SessionRuns.list(session.id)
            const saved = await SessionRuns.get(session.id, trusted.run_id)
            expect(runs.find((item) => item.run_id === trusted.run_id)?.summary).toBe("New trusted historical result")
            expect(runs.find((item) => item.run_id === trusted.run_id)?.summary_source).toBe("protocol")
            expect(runs.find((item) => item.run_id === trusted.run_id)?.fallback).toBe(false)
            expect(saved?.summary).toBe("New trusted historical result")
            expect(runs.find((item) => item.run_id === delegated.run_id)?.summary).toBe("Delegated historical result")
            expect(runs.find((item) => item.run_id === delegated.run_id)?.summary_source).toBe("protocol")
            expect(runs.find((item) => item.run_id === forged.run_id)?.summary).toBeUndefined()
            expect(runs.find((item) => item.run_id === internal.run_id)?.summary).toBeUndefined()
            expect(runs.find((item) => item.run_id === source.run_id)?.summary).toBeUndefined()
            expect(
              await Storage.read(["session_protocol_run_outcome", session.id, trusted.run_id]).catch(() => undefined),
            ).toBeUndefined()
          },
        }),
    })
  })

  test("rejects traversal, absolute paths, non-markdown files, and symlinks", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_session_run_paths"),
          fn: async () => {
            const session = await Session.create({})
            const run = result("run_paths")
            await Storage.write(["session_protocol_run", session.id, run.run_id], run)
            const dir = path.join(tmp.path, ".harness", "sessions", session.id, "runs", run.run_id, "plans")
            await Bun.write(path.join(dir, "task.md"), "safe")
            await Bun.write(path.join(dir, "task.txt"), "unsafe")
            await symlink(path.join(dir, "task.md"), path.join(dir, "link.md"))
            const outside = path.join(tmp.path, "outside")
            await Bun.write(path.join(outside, "leak.md"), "secret")
            await symlink(outside, path.join(path.dirname(dir), "reviews"))
            await Bun.write(path.join(path.dirname(dir), "requirements", "nested", "task.md"), "nested")
            await Bun.write(path.join(tmp.path, ".harness", "sessions", session.id, "plans", "escaped.md"), "escaped")

            expect(await SessionRuns.read(session.id, run.run_id, "../plans/task.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "/plans/task.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "plans/task.txt")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "plans/link.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, run.run_id, "reviews/leak.md")).toBeUndefined()
            expect(await SessionRuns.read(session.id, "..", "plans/escaped.md")).toBeUndefined()
            expect((await SessionRuns.documents(session.id, run.run_id)).map((item) => item.path)).toEqual([
              "plans/task.md",
            ])
          },
        }),
    })
  })
})

function result(id: string, status: "completed" | "blocked" | "failed" = "completed") {
  const now = Date.now()
  return AgentProtocol.Result.parse({
    type: "agent.protocol.result",
    version: "1",
    run_id: id,
    status,
    title: "Planning run",
    actions: [
      {
        id: "backend",
        title: "Backend task",
        operation: "agent",
        executor: { type: "agent", target: "backend" },
        input: { prompt: "Implement backend" },
        depends_on: [],
        status: "completed",
        summary: "Done",
        tool_call_ids: [],
        duration_ms: 1,
        time: { started: now, completed: now + 1 },
      },
    ],
    summary: "Completed",
    time: { started: now, completed: now + 1 },
    metrics: {
      actions: 1,
      internal_tool_calls: 0,
      direct_model_tool_calls: 0,
      model_visible_bytes: 0,
      raw_output_bytes: 0,
      duration_ms: 1,
    },
  })
}

async function reply(
  sessionID: SessionID,
  runID: string,
  text: string,
  trust: "turn" | "delegation" | "internal" | "source" | "plain",
) {
  const user = MessageID.ascending()
  const assistant = MessageID.ascending()
  const now = Date.now()
  await Session.updateMessage({
    id: user,
    sessionID,
    role: "user",
    time: { created: now },
    agent: "test",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    metadata: {
      ...(trust === "delegation" || trust === "internal" ? { internal: true } : {}),
      ...(trust === "delegation" || trust === "source" ? { source: "delegation" } : {}),
      run_id: runID,
      turn: {
        kind: trust === "turn" ? "user" : "internal",
        status: "done",
        outcome: "completed",
        reason: "protocol",
        assistant_id: assistant,
        ...(trust === "turn" ? { run_id: runID } : {}),
        time: { queued: now, started: now, completed: now },
      },
    },
  } as MessageV2.User)
  await Session.updateMessage({
    id: assistant,
    sessionID,
    role: "assistant",
    parentID: user,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "test",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now, completed: now },
    finish: "stop",
  } as MessageV2.Assistant)
  const part = PartID.ascending()
  await Session.updatePart({
    id: part,
    sessionID,
    messageID: assistant,
    type: "text",
    text,
    metadata: { kind: "protocol_response" },
  })
  return { assistant, part, user }
}

async function delegation(run: string, plan: string) {
  const parent = await Session.create({ agent: "protocol-runner" })
  const child = await Session.create({ parentID: parent.id, agent: "backend" })
  const action = AgentProtocol.Action.parse({
    id: "backend",
    title: "Backend task",
    operation: "agent",
    executor: { type: "agent", target: "backend" },
    input: { prompt: "Implement backend" },
    result_policy: "structured",
  })
  const message = MessageID.ascending()
  const packet = {
    type: "agent.delegation.assignment",
    version: "1",
    run_id: run,
    action_id: action.id,
    action_title: action.title,
    parent_session_id: parent.id,
    parent_message_id: message,
    parent_agent: "protocol-runner",
    child_session_id: child.id,
    agent: "backend",
    result_policy: "structured",
    result_tool: "ActionResult",
    created_at: Date.now(),
  }
  await SessionAssignment.delegate({
    action,
    childID: child.id,
    messageID: message,
    plan,
    runID: run,
    sessionID: parent.id,
  })
  await Session.setDslContext({ sessionID: child.id, dsl_context: { protocol: { delegation: packet } } })
  return { parent, child, action, packet, run }
}

async function resultref(child: SessionID, packet: Awaited<ReturnType<typeof delegation>>["packet"], id: string) {
  await Session.setDslContext({
    sessionID: child,
    dsl_context: {
      protocol: { delegation: packet },
      result: { result_id: id },
    },
  })
}
