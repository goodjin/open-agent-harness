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
    .get("/runs/:runID/decisions", validator("param", RunParam), async (c) =>
      c.json(await HarnessStore.decisions(c.req.valid("param").runID)),
    )
    .get("/runs/:runID/events", validator("param", RunParam), async (c) => c.json(await HarnessStore.events(c.req.valid("param").runID)))
    .get("/runs/:runID/graph", validator("param", RunParam), async (c) => c.json(await HarnessRuntime.graph(c.req.valid("param").runID)))
    .get("/runs/:runID/audit", validator("param", RunParam), async (c) => c.json(await HarnessRuntime.audit(c.req.valid("param").runID)))
    .get("/runs/:runID/audit/export", validator("param", RunParam), async (c) => {
      const format = c.req.query("format") === "markdown" ? "markdown" : "json"
      const data = await HarnessRuntime.exportAudit(c.req.valid("param").runID, format)
      if (format === "markdown") return c.text(data as string)
      return c.json(data)
    })
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
