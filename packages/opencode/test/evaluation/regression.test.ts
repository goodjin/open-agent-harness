import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { getRegistry } from "../../src/agent/registry"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionTimeline } from "../../src/session/timeline"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
  await Instance.disposeAll()
})

async function workflow(dir: string) {
  const root = path.join(dir, ".opencode", "workflows")
  await fs.mkdir(root, { recursive: true })
  await Bun.write(
    path.join(root, "regression.json"),
    JSON.stringify({
      id: "regression",
      name: "Regression",
      steps: [{ id: "one", outputs: { ok: true } }],
    }),
  )
}

describe("MOD-15 regression scenarios", () => {
  test("agent switch, permission, restore, and workflow paths remain coherent", async () => {
    await using tmp = await tmpdir({ git: true })
    await workflow(tmp.path)
    const space = WorkspaceID.make("wrk_regression")
    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        WorkspaceContext.provide({
          workspaceID: space,
          fn: async () => {
            const agent = await getRegistry().switch("default")
            const session = await Session.create({
              permission: [{ permission: "bash", pattern: "*", action: "allow" }],
            })
            const rule = PermissionNext.evaluate("bash", "ls", session.permission ?? [])
            await Bun.write(path.join(tmp.path, "restore.txt"), "before\n")
            await $`git add restore.txt`.cwd(tmp.path).quiet()
            await $`git commit -m restore-base`.cwd(tmp.path).quiet()
            const hash = await Snapshot.track()
            if (!hash) throw new Error("missing snapshot hash")
            await Bun.write(path.join(tmp.path, "restore.txt"), "after\n")
            const msg = await Session.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "default",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              tools: {},
            })
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: session.id,
              type: "step-start",
              snapshot: hash,
              permission: session.permission,
              dsl_context: { before: true },
            })
            const checkpoints = await SessionTimeline.list(session.id)
            await SessionTimeline.restore(session.id, hash)
            const state = await WorkflowExecutor.run({ sessionID: session.id, workflowID: "regression" })

            expect(agent?.id).toBe("default")
            expect(rule.action).toBe("allow")
            expect(checkpoints[0].hash).toBe(hash)
            expect(await Bun.file(path.join(tmp.path, "restore.txt")).text()).toBe("before\n")
            expect(state.status).toBe("completed")
          },
        }),
    })
  })
})
