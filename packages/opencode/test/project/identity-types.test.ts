import { describe, expect, test } from "bun:test"
import { WorkspaceID, type WorkspaceID as Workspace } from "../../src/control-plane/schema"
import { ProjectID, type ProjectID as Project } from "../../src/project/schema"
import { Worktree } from "../../src/worktree"

function project(id: Project) {
  return id
}

function workspace(id: Workspace) {
  return id
}

describe("project workspace identity types", () => {
  test("keeps project and workspace ids distinct at compile time", () => {
    const pid = ProjectID.make("project_test")
    const wid = WorkspaceID.ascending()
    const dir: Worktree.Info["directory"] = "/tmp/project-worktree"

    expect(project(pid)).toBe(pid)
    expect(workspace(wid)).toBe(wid)
    expect(dir).toBe("/tmp/project-worktree")

    // @ts-expect-error WorkspaceID must not be accepted as ProjectID.
    project(wid)
    // @ts-expect-error ProjectID must not be accepted as WorkspaceID.
    workspace(pid)
  })
})
