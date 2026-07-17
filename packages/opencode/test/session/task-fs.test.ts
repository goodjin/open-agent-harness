import { expect, test } from "bun:test"
import { mkdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs"
import path from "path"
import { Instance } from "../../src/project/instance"
import { TaskFS } from "../../src/session/task-fs"
import { tmpdir } from "../fixture/fixture"

const posix = process.platform === "darwin" || process.platform === "linux" ? test : test.skip

async function setup(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn })
}

function locker(root: string[], mode: "hold" | "crash", ready: string, release = "") {
  return Bun.spawn(
    [
      "bun",
      "-e",
      `
        import { existsSync, writeFileSync } from "fs"
        import { Instance } from "./src/project/instance.ts"
        import { TaskFS } from "./src/session/task-fs.ts"
        const result = await Instance.provide({
          directory: process.env.TASK_PROJECT,
          fn: () => TaskFS.manifest(JSON.parse(process.env.TASK_ROOT), () => {
            writeFileSync(process.env.TASK_READY, "ready")
            if (process.env.TASK_MODE === "crash") process.exit(0)
            while (!existsSync(process.env.TASK_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
            return "child manifest"
          }),
        })
        console.log("LOCK_RESULT:" + result)
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        TASK_MODE: mode,
        TASK_PROJECT: Instance.directory,
        TASK_READY: ready,
        TASK_RELEASE: release,
        TASK_ROOT: JSON.stringify(root),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
}

async function ready(file: string) {
  for (let count = 0; count < 400; count++) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

test("task fs rejects empty, dot, separator, and NUL segments", () => {
  for (const part of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(TaskFS.segment(part)).toBe(false)
  expect(TaskFS.segment("task_123-v1.md")).toBe(true)
})

test("task fs rejects a publish without a target file segment", () =>
  setup(async () => {
    expect(TaskFS.publish([".harness"], [], "trusted")).toBe(false)
    expect(await Bun.file(path.join(Instance.directory, ".harness", "undefined")).exists()).toBe(false)
  }))

posix("task fs refuses a symlink directory component without writing outside", () =>
  setup(async () => {
    const outside = path.join(Instance.directory, "outside")
    mkdirSync(outside)
    symlinkSync(outside, path.join(Instance.directory, ".harness"))

    expect(TaskFS.publish([".harness", "sessions", "session_1"], ["task.md"], "trusted")).toBe(false)
    expect(await Bun.file(path.join(outside, "sessions", "session_1", "task.md")).exists()).toBe(false)
  }),
)

posix("task fs keeps rename relative to an opened directory", () =>
  setup(async () => {
    const root = [".harness", "sessions", "session_1", "tasks", "task_1"]
    const target = path.join(Instance.directory, ...root, "revisions", "v1")
    const outside = path.join(Instance.directory, "outside")
    mkdirSync(outside)
    let tmp = ""
    using hook = TaskFS.testing({
      publish(name) {
        tmp = name
        renameSync(target, `${target}-safe`)
        writeFileSync(path.join(outside, name), "attacker")
        symlinkSync(outside, target)
      },
    })

    expect(TaskFS.publish(root, ["revisions", "v1", "task.md"], "trusted")).toBe(true)
    expect(tmp).not.toBe("")
    expect(await Bun.file(path.join(outside, "task.md")).exists()).toBe(false)
    expect(await Bun.file(path.join(outside, tmp)).text()).toBe("attacker")
    expect(await Bun.file(path.join(`${target}-safe`, "task.md")).text()).toBe("trusted")
  }),
)

test("task fs fails closed when the native backend is unavailable", () =>
  setup(async () => {
    using hook = TaskFS.testing({ backend: null })
    expect(TaskFS.publish([".harness"], ["task.md"], "trusted")).toBe(false)
    expect(TaskFS.manifest([".harness", "tasks", "task_1"], () => "manifest")).toBe(false)
    expect(await Bun.file(path.join(Instance.directory, ".harness")).exists()).toBe(false)
  }))

posix("task fs preserves a legacy directory lock and fails closed", () =>
  setup(async () => {
    const root = [".harness", "sessions", "session_1", "tasks", "task_1"]
    expect(TaskFS.publish(root, ["revisions", "v1", "task.md"], "first")).toBe(true)
    expect(TaskFS.publish(root, ["revisions", "v1", "task.md"], "second")).toBe(true)
    const lock = path.join(Instance.directory, ".harness", "sessions", "session_1", "tasks", "task_1.manifest.lock")
    mkdirSync(lock)
    writeFileSync(path.join(lock, "sentinel"), "keep")
    const stale = new Date(Date.now() - 31_000)
    utimesSync(lock, stale, stale)

    expect(TaskFS.manifest(root, () => "manifest")).toBe(false)
    expect(await Bun.file(path.join(lock, "sentinel")).text()).toBe("keep")
    expect(await Bun.file(path.join(Instance.directory, ...root, "manifest.md")).exists()).toBe(false)
  }),
)

posix("task fs keeps one regular lock file across normal acquire and release", () =>
  setup(async () => {
    const root = [".harness", "sessions", "session_1", "tasks", "task_1"]
    const lock = path.join(Instance.directory, ...root, ".manifest.lock")
    expect(TaskFS.manifest(root, () => "first")).toBe(true)
    expect(statSync(lock).isFile()).toBe(true)
    const ino = statSync(lock).ino
    expect(TaskFS.manifest(root, () => "second")).toBe(true)
    expect(statSync(lock).ino).toBe(ino)
  }),
)

posix("task fs refuses a symlink manifest lock file", () =>
  setup(async () => {
    const root = [".harness", "sessions", "session_1", "tasks", "task_1"]
    expect(TaskFS.publish(root, ["revisions", "v1", "task.md"], "body")).toBe(true)
    const outside = path.join(Instance.directory, "outside-lock")
    writeFileSync(outside, "keep")
    symlinkSync(outside, path.join(Instance.directory, ...root, ".manifest.lock"))

    expect(TaskFS.manifest(root, () => "manifest")).toBe(false)
    expect(await Bun.file(outside).text()).toBe("keep")
  }),
)

posix("task fs flock times out across processes and releases when an owner crashes", () =>
  setup(async () => {
    const root = [".harness", "sessions", "session_1", "tasks", "task_1"]
    expect(TaskFS.publish(root, ["revisions", "v1", "task.md"], "body")).toBe(true)
    const owner = locker(
      root,
      "hold",
      path.join(Instance.directory, "owner-ready"),
      path.join(Instance.directory, "owner-release"),
    )
    await ready(path.join(Instance.directory, "owner-ready"))
    const start = Date.now()
    expect(TaskFS.manifest(root, () => "contender")).toBe(false)
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_800)
    await Bun.write(path.join(Instance.directory, "owner-release"), "release")
    expect(await owner.exited).toBe(0)
    expect(await new Response(owner.stdout).text()).toContain("LOCK_RESULT:true")
    expect(TaskFS.manifest(root, () => "after release")).toBe(true)

    const crash = locker(root, "crash", path.join(Instance.directory, "crash-ready"))
    await ready(path.join(Instance.directory, "crash-ready"))
    expect(await crash.exited).toBe(0)
    expect(TaskFS.manifest(root, () => "after crash")).toBe(true)
  }),
)
