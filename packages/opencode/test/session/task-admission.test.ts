import { describe, expect, test } from "bun:test"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Admission } from "../../src/session/task-admission"
import { SessionTask } from "../../src/session/task"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

async function setup<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  try {
    return await Instance.provide({
      directory: tmp.path,
      fn: () =>
        WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_task_admission"),
          fn,
        }),
    })
  } finally {
    await resetDatabase()
  }
}

describe("task admission gate", () => {
  test("waits for pending confirmation added to the same generation", async () => {
    const first = Admission.signal("same")
    const waiting = Admission.wait("same", 1_000)
    await Promise.resolve()
    await Promise.resolve()
    const second = Admission.signal("same")
    first()
    let done = false
    waiting.then(() => {
      done = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    second()
    expect(await waiting).toBe(true)
  })

  test("keeps a new generation when an old release is called again", async () => {
    const old = Admission.signal("stale")
    old()
    const next = Admission.signal("stale")
    old()
    const waiting = Admission.wait("stale", 1_000)
    await Promise.resolve()
    await Promise.resolve()
    let done = false
    waiting.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    next()
    expect(await waiting).toBe(true)
  })

  test("rechecks a new generation created while the old snapshot settles", async () => {
    const old = Admission.signal("next")
    const waiting = Admission.wait("next", 1_000)
    await Promise.resolve()
    await Promise.resolve()
    old()
    const next = Admission.signal("next")
    let done = false
    waiting.then(() => {
      done = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    next()
    expect(await waiting).toBe(true)
  })

  test("does not make another session wait", async () => {
    const release = Admission.signal("left")
    expect(await Admission.wait("right", 50)).toBe(true)
    release()
  })

  test(
    "fails ordinary admission closed on timeout and allows retry only after release",
    () =>
      setup(async () => {
        const session = await Session.create({})
        const release = Admission.signal(session.id)
        await expect(
          SessionTask.route({
            sessionID: session.id,
            runID: "run_admission_timeout",
            legacy: { title: "Timeout", body: "Timeout" },
            actions: [{ id: "timeout" }],
          }),
        ).rejects.toThrow("session_task_admission_pending")
        expect(await SessionTask.get(session.id)).toBeUndefined()
        expect(await Admission.wait(session.id, 10)).toBe(false)

        release()
        await expect(
          SessionTask.route({
            sessionID: session.id,
            runID: "run_admission_retry",
            legacy: { title: "Retry", body: "Retry" },
            actions: [{ id: "retry" }],
          }),
        ).resolves.toMatchObject({ type: "execute", revision: { version: 1 } })
      }),
    10_000,
  )

  test(
    "cancels the deadline timer when a pending confirmation releases quickly",
    async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "-e",
          `
            import { Admission } from ${JSON.stringify(new URL("../../src/session/task-admission.ts", import.meta.url).href)}
            const release = Admission.signal("child")
            const waiting = Admission.wait("child")
            await Promise.resolve()
            await Promise.resolve()
            release()
            process.stdout.write(String(await waiting))
          `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(stderr || stdout)
      expect(stdout).toBe("true")
    },
    2_000,
  )
})
