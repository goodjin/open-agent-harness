import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Database, eq } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function seed(opts: { id: SessionID; dir: string; project: ProjectID }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: opts.project,
        slug: opts.id,
        directory: opts.dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

function ensureGlobal() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("migrateFromGlobal", () => {
  test("migrates global sessions on first project creation", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    await $`git config user.name "Test"`.cwd(tmp.path).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(tmp.path).quiet()
    ensureGlobal()

    const id = uid()
    seed({ id, dir: tmp.path, project: ProjectID.global })

    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(project.id)
  })

  test("migrates local fallback sessions when a root commit appears", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    await $`git config user.name "Test"`.cwd(tmp.path).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(tmp.path).quiet()
    const { project: local } = await Project.fromDirectory(tmp.path)
    expect(local.id).not.toBe(ProjectID.global)

    const id = uid()
    seed({ id, dir: tmp.path, project: local.id })

    await $`git commit --allow-empty -m "root"`.cwd(tmp.path).quiet()
    const { project: real } = await Project.fromDirectory(tmp.path)
    expect(real.id).not.toBe(ProjectID.global)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(real.id)
  })

  test("migrates global sessions even when project row already exists", async () => {
    // 1. Create a repo with a commit — real project ID created immediately
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    // 2. Ensure "global" project row exists (as it would from a prior no-git session)
    ensureGlobal()

    // 3. Seed a session under "global" with matching directory.
    //    This simulates a session created before git init that wasn't
    //    present when the real project row was first created.
    const id = uid()
    seed({ id, dir: tmp.path, project: ProjectID.global })

    // 4. Call fromDirectory again — project row already exists,
    //    so the current code skips migration entirely. This is the bug.
    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(project.id)
  })

  test("migrates sessions from a previous parent project when the directory becomes its own project", async () => {
    await using tmp = await tmpdir()
    const child = `${tmp.path}/lowcode-ai`
    await $`mkdir -p ${child}`.quiet()
    await $`git init`.cwd(child).quiet()
    await $`git config user.name "Test"`.cwd(child).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(child).quiet()

    const old = ProjectID.make("local-old-parent-project")
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id: old,
          worktree: tmp.path,
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        .run(),
    )

    const id = uid()
    seed({ id, dir: child, project: old })

    const { project } = await Project.fromDirectory(child)
    expect(project.id).not.toBe(old)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(project.id)
  })

  test("does not claim sessions with empty directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    ensureGlobal()

    // Legacy sessions may lack a directory value.
    // Without a matching origin directory, they should remain global.
    const id = uid()
    seed({ id, dir: "", project: ProjectID.global })

    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(ProjectID.global)
  })

  test("does not steal sessions from unrelated directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    ensureGlobal()

    // Seed a session under "global" but for a DIFFERENT directory
    const id = uid()
    seed({ id, dir: "/some/other/dir", project: ProjectID.global })

    await Project.fromDirectory(tmp.path)

    const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
    expect(row).toBeDefined()
    // Should remain under "global" — not stolen
    expect(row!.project_id).toBe(ProjectID.global)
  })
})
