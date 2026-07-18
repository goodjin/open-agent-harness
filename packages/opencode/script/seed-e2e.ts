const dir = process.env.OPENCODE_E2E_PROJECT_DIR ?? process.cwd()
const title = process.env.OPENCODE_E2E_SESSION_TITLE ?? "E2E Session"
const text = process.env.OPENCODE_E2E_MESSAGE ?? "Seeded for UI e2e"
const model = process.env.OPENCODE_E2E_MODEL ?? "opencode/gpt-5-nano"
const parts = model.split("/")
const providerID = parts[0] ?? "opencode"
const modelID = parts[1] ?? "gpt-5-nano"
const now = Date.now()

const seed = async () => {
  const { Instance } = await import("../src/project/instance")
  const { InstanceBootstrap } = await import("../src/project/bootstrap")
  const { Config } = await import("../src/config/config")
  const { Session } = await import("../src/session")
  const { MessageID, PartID } = await import("../src/session/schema")
  const { Project } = await import("../src/project/project")
  const { ModelID, ProviderID } = await import("../src/provider/schema")
  const { ToolRegistry } = await import("../src/tool/registry")

  await Instance.provide({
    directory: dir,
    init: InstanceBootstrap,
    fn: async () => {
      await Config.waitForDependencies()
      await ToolRegistry.ids()

      const session = await Session.create({ title })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const message = {
        id: messageID,
        sessionID: session.id,
        role: "user" as const,
        time: { created: now },
        agent: "build",
        model: {
          providerID: ProviderID.make(providerID),
          modelID: ModelID.make(modelID),
        },
      }
      const part = {
        id: partID,
        sessionID: session.id,
        messageID,
        type: "text" as const,
        text,
        time: { start: now },
      }
      await Session.updateMessage(message)
      await Session.updatePart(part)
      if (process.env.OPENCODE_E2E_TASK_PROPOSAL === "true") {
        const assistant = MessageID.ascending()
        await Session.updateMessage({
          id: assistant,
          sessionID: session.id,
          parentID: messageID,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make(modelID),
          providerID: ProviderID.make(providerID),
          time: { created: now + 1, completed: now + 2 },
        })
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant,
          type: "text",
          text: "Task update proposal",
          synthetic: true,
          ignored: true,
          metadata: {
            kind: "task_update_proposal",
            proposal_id: "run_e2e:update_e2e",
            old_revision_id: "revision_e2e",
            difference_summary: "Mounted proposal card",
            affected_child_ids: [],
            reusable_result_refs: [],
            status: "pending",
          },
          time: { start: now + 1, end: now + 2 },
        })
      }
      await Project.update({ projectID: Instance.project.id, name: "E2E Project" })
    },
  })
}

await seed()
