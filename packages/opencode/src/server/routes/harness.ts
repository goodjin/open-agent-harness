import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Harness, HarnessRuntime, HarnessStore } from "@/harness"
import { errors } from "../error"
import { lazy } from "@/util/lazy"

const RunParam = z.object({ runID: z.string() })
const TaskParam = z.object({ taskID: z.string() })
const DecisionParam = z.object({ decisionID: z.string() })
const ConceptParam = z.object({ conceptID: z.string() })
const EventParam = z.object({ eventID: z.string() })
const WorkflowParam = z.object({ workflowID: z.string() })
const ProjectionPath = z.object({ runID: z.string(), name: z.string() })
const ResourcePath = z.object({ runID: z.string(), resourceID: z.string() })

function toScore(input: string | undefined) {
  if (input === "owner") return 4
  if (input === "team") return 3
  if (input === "project") return 2
  if (input === "user") return 1
  return 2
}

function toMarkdown(run: { id: string; name: string }, data: { events: Harness.Event[]; resources: Harness.ResourceRecord[]; handoffs: Harness.HandoffRecord[] }) {
  const lines = [
    `# Trace Export: ${run.name}`,
    `Run: ${run.id}`,
    "",
    "## Events",
    ...data.events.map((item) => `- ${new Date(item.time).toISOString()} ${item.type} ${item.summary ?? item.actor}`),
    "",
    "## Resources",
    ...data.resources.map((item) => `- ${item.id} ${item.kind} ${item.summary}`),
    "",
    "## Handoffs",
    ...data.handoffs.map((item) => `- ${item.kind} ${item.state} ${item.summary}`),
  ]
  return lines.join("\n")
}

function command(type: Harness.Command["type"], input: Partial<Harness.Command>) {
  return HarnessRuntime.command(Harness.Command.parse({ ...input, type }))
}

export const HarnessRoutes = lazy(() =>
  new Hono()
    .get(
      "/runs",
      describeRoute({
        summary: "List harness runs",
        operationId: "harness.runs",
        responses: {
          200: {
            description: "Harness runs",
            content: { "application/json": { schema: resolver(Harness.Run.array()) } },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await HarnessStore.runs()),
    )
    .post(
      "/runs",
      describeRoute({
        summary: "Create harness run",
        operationId: "harness.run.create",
        responses: {
          200: {
            description: "Harness run",
            content: { "application/json": { schema: resolver(Harness.Run) } },
          },
          ...errors(400),
        },
      }),
      validator("json", Harness.CreateRun),
      async (c) => c.json(await HarnessRuntime.create(c.req.valid("json"))),
    )
    .get(
      "/runs/:runID",
      describeRoute({
        summary: "Get harness run",
        operationId: "harness.run.get",
        responses: {
          200: {
            description: "Harness run summary",
            content: { "application/json": { schema: resolver(Harness.Summary.nullable()) } },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json((await HarnessStore.summary(c.req.valid("param").runID)) ?? null),
    )
    .get(
      "/runs/:runID/resources",
      describeRoute({
        summary: "List harness run resources",
        operationId: "harness.run.resources",
        responses: {
          200: {
            description: "Harness run resources",
            content: {
              "application/json": {
                schema: resolver(Harness.ResourceRecord.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json(await HarnessStore.resources(c.req.valid("param").runID)),
    )
    .get(
      "/runs/:runID/agent-sessions",
      describeRoute({
        summary: "List harness run agent sessions",
        operationId: "harness.run.agent-sessions",
        responses: {
          200: {
            description: "Harness run agent sessions",
            content: {
              "application/json": {
                schema: resolver(Harness.AgentSessionRecord.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json(await HarnessStore.agentSessions(c.req.valid("param").runID)),
    )
    .get(
      "/runs/:runID/handoffs",
      describeRoute({
        summary: "List harness run handoffs",
        operationId: "harness.run.handoffs",
        responses: {
          200: {
            description: "Harness run handoffs",
            content: {
              "application/json": {
                schema: resolver(Harness.HandoffRecord.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json(await HarnessStore.handoffs(c.req.valid("param").runID)),
    )
    .get(
      "/runs/:runID/acceptance",
      describeRoute({
        summary: "List harness run acceptance records",
        operationId: "harness.run.acceptance",
        responses: {
          200: {
            description: "Harness run acceptance records",
            content: {
              "application/json": {
                schema: resolver(Harness.AcceptanceRecord.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json(await HarnessStore.acceptance(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/tasks", validator("param", RunParam), async (c) => c.json(await HarnessStore.tasks(c.req.valid("param").runID)))
    .get("/runs/:runID/assignments", validator("param", RunParam), async (c) =>
      c.json(await HarnessStore.assignments(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/artifacts", validator("param", RunParam), async (c) =>
      c.json(await HarnessStore.artifacts(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/resources/:resourceID", validator("param", ResourcePath), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 2) return c.json({ message: "forbidden" }, 403)
      const { runID, resourceID } = c.req.valid("param")
      const item = await HarnessStore.resource(runID, resourceID)
      if (!item) return c.json({ message: `Resource not found: ${resourceID}` }, 404)
      return c.json(item)
    })
    .get("/runs/:runID/resources/:resourceID/preview", validator("param", ResourcePath), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 2) return c.json({ message: "forbidden" }, 403)
      const { runID, resourceID } = c.req.valid("param")
      return c.json(await HarnessRuntime.previewResource(runID, resourceID))
    })
    .get("/runs/:runID/decisions", validator("param", RunParam), async (c) =>
      c.json(await HarnessStore.decisions(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/projections", validator("param", RunParam), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 2) return c.json({ message: "forbidden" }, 403)
      return c.json(await HarnessStore.projections(c.req.valid("param").runID))
    })
    .get("/runs/:runID/projections/:name", validator("param", ProjectionPath), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 2) return c.json({ message: "forbidden" }, 403)
      const { runID, name } = c.req.valid("param")
      const item = (await HarnessStore.projections(runID)).find((next) => next.name === name)
      if (!item) return c.json({ message: `Projection not found: ${name}` }, 404)
      return c.json(item)
    })
    .get("/runs/:runID/events", validator("param", RunParam), async (c) => c.json(await HarnessStore.events(c.req.valid("param").runID)))
    .get("/runs/:runID/graph", validator("param", RunParam), async (c) => c.json(await HarnessRuntime.graph(c.req.valid("param").runID)))
    .get("/runs/:runID/audit", validator("param", RunParam), async (c) => c.json(await HarnessRuntime.audit(c.req.valid("param").runID)))
    .get("/runs/:runID/audit/export", validator("param", RunParam), async (c) => {
      const format = c.req.query("format") === "markdown" ? "markdown" : "json"
      const data = await HarnessRuntime.exportAudit(c.req.valid("param").runID, format)
      if (format === "markdown") return c.text(data as string)
      return c.json(data)
    })
    .get("/runs/:runID/trace/export", validator("param", RunParam), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 3) return c.json({ message: "forbidden" }, 403)
      const id = c.req.valid("param").runID
      const run = await HarnessStore.run(id)
      const item = await HarnessStore.summary(id)
      if (!item) throw new Error(`Run not found: ${id}`)
      const data = {
        run_id: run.id,
        events: item.events,
        resources: item.resources,
        handoffs: item.handoffs,
      }
      if (c.req.query("format") === "markdown") return c.text(toMarkdown(run, data))
      return c.json(data)
    })
    .get("/runs/:runID/evaluation", validator("param", RunParam), async (c) => {
      const scope = toScore(c.req.query("scope"))
      if (scope < 2) return c.json({ message: "forbidden" }, 403)
      const id = c.req.valid("param").runID
      const run = await HarnessStore.run(id)
      const item = await HarnessStore.summary(id)
      if (!item) throw new Error(`Run not found: ${id}`)
      return c.json({
        run_id: run.id,
        outcome: {
          status: run.status,
          completed: run.progress.completed,
          total: run.progress.total,
        },
        metric: {
          events: item.events.length,
          resources: item.resources.length,
          actions: item.actions.length,
          acceptance: item.acceptance.length,
        },
      })
    })
    .get(
      "/runs/:runID/performance",
      describeRoute({
        summary: "Run performance summary",
        operationId: "harness.run.performance",
        responses: {
          200: {
            description: "Run performance profile",
            content: { "application/json": { schema: resolver(z.record(z.string(), z.unknown())) } },
          },
          ...errors(400),
        },
      }),
      validator("param", RunParam),
      async (c) => c.json(await HarnessRuntime.performance(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/projections/rebuild", validator("param", RunParam), async (c) => c.json(await HarnessRuntime.rebuild(c.req.valid("param").runID)))
    .get(
      "/agent-templates",
      describeRoute({
        summary: "List harness agent templates",
        operationId: "harness.agent.templates",
        responses: {
          200: {
            description: "Harness agent templates",
            content: {
              "application/json": {
                schema: resolver(Harness.AgentTemplateRecord.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await HarnessRuntime.agentTemplates()),
    )
    .get(
      "/workflows",
      describeRoute({
        summary: "List harness workflow assets",
        operationId: "harness.workflows",
        responses: {
          200: {
            description: "Harness workflow assets",
            content: {
              "application/json": {
                schema: resolver(Harness.WorkflowAsset.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await HarnessRuntime.workflows()),
    )
    .get(
      "/workflows/:workflowID",
      describeRoute({
        summary: "Get harness workflow asset",
        operationId: "harness.workflow.get",
        responses: {
          200: {
            description: "Harness workflow asset",
            content: {
              "application/json": {
                schema: resolver(Harness.WorkflowAsset.nullable()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", WorkflowParam),
      async (c) => c.json(await HarnessStore.workflow(c.req.valid("param").workflowID)),
    )
    .post("/commands", validator("json", Harness.Command), async (c) => c.json(await HarnessRuntime.command(c.req.valid("json"))))
    .get("/performance", async (c) => c.json({ scheduler: HarnessRuntime.scheduler() }))
    .get("/agents/templates", async (c) => c.json(await HarnessStore.agentTemplates()))
    .post("/agents/templates", validator("json", Harness.AgentTemplateRecord), async (c) => {
      const item = Harness.AgentTemplateRecord.parse(c.req.valid("json"))
      await HarnessStore.putAgentTemplate(item)
      return c.json(item)
    })
    .post("/workflows", validator("json", Harness.WorkflowAsset), async (c) => {
      const item = Harness.WorkflowAsset.parse(c.req.valid("json"))
      await HarnessStore.putWorkflow(item)
      return c.json(item)
    })
    .post("/runs/:runID/pause", validator("param", RunParam), async (c) =>
      c.json(await command("run.pause", { run_id: c.req.valid("param").runID })),
    )
    .post("/runs/:runID/resume", validator("param", RunParam), async (c) =>
      c.json(await command("run.resume", { run_id: c.req.valid("param").runID })),
    )
    .post("/runs/:runID/abort", validator("param", RunParam), async (c) =>
      c.json(await command("run.abort", { run_id: c.req.valid("param").runID })),
    )
    .post("/tasks/:taskID/retry", validator("param", TaskParam), validator("json", z.object({ run_id: z.string() })), async (c) =>
      c.json(await command("task.retry", { run_id: c.req.valid("json").run_id, task_id: c.req.valid("param").taskID })),
    )
    .post("/tasks/:taskID/cancel", validator("param", TaskParam), validator("json", z.object({ run_id: z.string() })), async (c) =>
      c.json(await command("task.cancel", { run_id: c.req.valid("json").run_id, task_id: c.req.valid("param").taskID })),
    )
    .post(
      "/decisions/:decisionID/answer",
      validator("param", DecisionParam),
      validator("json", z.object({ run_id: z.string(), answer: z.string() })),
      async (c) =>
        c.json(
          await command("decision.answer", {
            run_id: c.req.valid("json").run_id,
            decision_id: c.req.valid("param").decisionID,
            payload: { answer: c.req.valid("json").answer },
          }),
        ),
    )
    .post(
      "/verifications/:taskID/rerun",
      validator("param", TaskParam),
      validator("json", z.object({ run_id: z.string() })),
      async (c) => c.json(await command("verify.rerun", { run_id: c.req.valid("json").run_id, task_id: c.req.valid("param").taskID })),
    )
    .get("/memory/query", async (c) => {
      const query = c.req.query("q")?.toLowerCase()
      const scope = c.req.query("scope")
      const list = await HarnessStore.memories()
      return c.json(
        list.filter((item) => {
          if (scope && item.scope !== scope) return false
          if (!query) return true
          return `${item.kind} ${item.summary} ${item.namespace}`.toLowerCase().includes(query)
        }),
      )
    })
    .get("/events", async (c) =>
      c.json(
        await HarnessRuntime.eventQuery({
          run: c.req.query("run"),
          task: c.req.query("task"),
          actor: c.req.query("actor"),
          type: c.req.query("type"),
          concept: c.req.query("concept"),
          limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
          cursor: c.req.query("cursor"),
        }),
      ),
    )
    .get("/events/:eventID", validator("param", EventParam), async (c) => c.json((await HarnessStore.event(c.req.valid("param").eventID)) ?? null))
    .get("/events/:eventID/chain", validator("param", EventParam), async (c) => c.json(await HarnessRuntime.chain(c.req.valid("param").eventID)))
    .get("/concepts", async (c) => c.json(await HarnessStore.concepts()))
    .get("/concepts/graph", async (c) => c.json(await HarnessRuntime.concepts()))
    .get("/concepts/:conceptID/graph", validator("param", ConceptParam), async (c) => c.json(await HarnessRuntime.concepts(c.req.valid("param").conceptID)))
    .get("/concepts/:conceptID", validator("param", ConceptParam), async (c) => c.json((await HarnessStore.concept(c.req.valid("param").conceptID)) ?? null)),
)
