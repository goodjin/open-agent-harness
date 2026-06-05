import path from "path"
import { appendFile, mkdir } from "fs/promises"
import z from "zod"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Harness } from "./schema"

export namespace HarnessStore {
  const enc = new TextEncoder()

  function root() {
    return path.join(Instance.directory, ".opencode", "harness")
  }

  function runDir(id: string) {
    return path.join(root(), "runs", id)
  }

  function govDir() {
    return path.join(root(), "governance")
  }

  function graphDir(id: string) {
    return path.join(runDir(id), "action-graph")
  }

  function actionsDir(id: string) {
    return path.join(graphDir(id), "actions")
  }

  function resourceDir(id: string) {
    return path.join(runDir(id), "resources")
  }

  function indexDir(id: string) {
    return path.join(resourceDir(id), "index")
  }

  function bodyDir(id: string) {
    return path.join(resourceDir(id), "body")
  }

  function contextsDir(id: string) {
    return path.join(runDir(id), "contexts")
  }

  function templatesDir() {
    return path.join(govDir(), "agents", "templates")
  }

  function sessionsDir(id: string) {
    return path.join(runDir(id), "agent-sessions")
  }

  async function exists(file: string) {
    return Filesystem.exists(file)
  }

  async function ensure(dir: string) {
    await mkdir(dir, { recursive: true })
  }

  async function read<T>(file: string, schema: { parse(input: unknown): T }, fallback: T) {
    if (!(await exists(file))) return fallback
    return schema.parse(await Bun.file(file).json())
  }

  async function write(file: string, data: unknown) {
    await Filesystem.write(file, enc.encode(JSON.stringify(data, null, 2) + "\n"))
  }

  async function list<T>(dir: string, schema: { parse(input: unknown): T }) {
    if (!(await exists(dir))) return [] as T[]
    const out: T[] = []
    for (const item of await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, absolute: true }))) {
      out.push(schema.parse(await Bun.file(item).json()))
    }
    return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }

  export async function runs() {
    const dir = path.join(root(), "runs")
    if (!(await exists(dir))) return [] as Harness.Run[]
    const out: Harness.Run[] = []
    for (const item of await Array.fromAsync(new Bun.Glob("*/run.json").scan({ cwd: dir, absolute: true }))) {
      out.push(Harness.Run.parse(await Bun.file(item).json()))
    }
    return out.sort((a, b) => b.updated_at - a.updated_at)
  }

  export async function run(id: string) {
    const item = await maybeRun(id)
    if (!item) throw new Error(`Run not found: ${id}`)
    return item
  }

  export async function maybeRun(id: string) {
    const file = path.join(runDir(id), "run.json")
    if (!(await exists(file))) return
    return Harness.Run.parse(await Bun.file(file).json())
  }

  export async function putRun(run: Harness.Run) {
    await write(path.join(runDir(run.id), "run.json"), run)
  }

  export async function tasks(id: string) {
    return list(path.join(runDir(id), "tasks"), Harness.Task)
  }

  export async function putTask(task: Harness.Task) {
    await write(path.join(runDir(task.run_id), "tasks", `${task.id}.json`), task)
  }

  export async function task(run: string, id: string) {
    const file = path.join(runDir(run), "tasks", `${id}.json`)
    if (!(await exists(file))) return
    return Harness.Task.parse(await Bun.file(file).json())
  }

  export async function assignments(id: string) {
    return list(path.join(runDir(id), "assignments"), Harness.Assignment)
  }

  export async function putAssignment(run: string, item: Harness.Assignment) {
    await write(path.join(runDir(run), "assignments", `${item.id}.json`), item)
  }

  export async function artifacts(id: string) {
    return list(path.join(runDir(id), "artifacts"), Harness.Artifact)
  }

  export async function putArtifact(item: Harness.Artifact) {
    await write(path.join(runDir(item.run_id), "artifacts", `${item.id}.json`), item)
  }

  export async function decisions(id: string) {
    return list(path.join(runDir(id), "decisions"), Harness.Decision)
  }

  export async function putDecision(item: Harness.Decision) {
    await write(path.join(runDir(item.run_id), "decisions", `${item.id}.json`), item)
  }

  export async function decision(run: string, id: string) {
    const file = path.join(runDir(run), "decisions", `${id}.json`)
    if (!(await exists(file))) return
    return Harness.Decision.parse(await Bun.file(file).json())
  }

  export async function events(id: string) {
    const file = path.join(runDir(id), "events.jsonl")
    if (!(await exists(file))) return [] as Harness.Event[]
    return (await Bun.file(file).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => Harness.Event.parse(JSON.parse(line)))
  }

  export async function allEvents() {
    const list = await runs()
    return (await Promise.all(list.map((item) => events(item.id))))
      .flat()
      .sort((a, b) => b.time - a.time)
  }

  export async function event(id: string) {
    return allEvents().then((list) => list.find((item) => item.id === id))
  }

  export async function append(event: Harness.Event) {
    if (!event.run_id) return
    const file = path.join(runDir(event.run_id), "events.jsonl")
    await ensure(path.dirname(file))
    await appendFile(file, JSON.stringify(event) + "\n")
  }

  export async function projection(id: string, name: string, data: unknown) {
    await write(path.join(runDir(id), "projections", `${name}.json`), data)
  }

  export async function projections(id: string) {
    const dir = path.join(runDir(id), "projections")
    if (!(await exists(dir))) return []
    return Promise.all(
      (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, absolute: true }))).map(async (file) => ({
        name: path.basename(file, ".json"),
        data: await Bun.file(file).json(),
      })),
    )
  }

  export async function memories() {
    return list(path.join(govDir(), "memory", "records"), Harness.Memory)
  }

  export async function concepts() {
    return list(path.join(govDir(), "concepts"), Harness.Concept)
  }

  export async function putConcept(item: Harness.Concept) {
    await write(path.join(govDir(), "concepts", `${item.id}.json`), item)
  }

  export async function concept(id: string) {
    const file = path.join(govDir(), "concepts", `${id}.json`)
    if (!(await exists(file))) return
    return Harness.Concept.parse(await Bun.file(file).json())
  }

  export async function actionGraph(id: string) {
    const file = path.join(graphDir(id), "graph.json")
    if (!(await exists(file))) return
    return Harness.ActionGraph.parse(await Bun.file(file).json())
  }

  export async function putActionGraph(item: Harness.ActionGraph) {
    await write(path.join(graphDir(item.run_id), "graph.json"), item)
  }

  export async function actions(id: string) {
    return (await list(actionsDir(id), Harness.ActionRecord)).sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function action(run: string, id: string) {
    const file = path.join(actionsDir(run), `${id}.json`)
    if (!(await exists(file))) return
    return Harness.ActionRecord.parse(await Bun.file(file).json())
  }

  export async function putAction(item: Harness.ActionRecord) {
    await write(path.join(actionsDir(item.run_id), `${item.id}.json`), item)
  }

  export async function edges(id: string) {
    return (await read(path.join(graphDir(id), "edges.json"), z.array(Harness.ActionEdge), [])).sort((a, b) => `${a.to}:${a.from}`.localeCompare(`${b.to}:${b.from}`))
  }

  export async function putEdges(run: string, list: Harness.ActionEdge[]) {
    await write(path.join(graphDir(run), "edges.json"), z.array(Harness.ActionEdge).parse(list))
  }

  export async function resources(id: string) {
    return (await list(indexDir(id), Harness.ResourceRecord)).sort((a, b) => b.updated_at - a.updated_at)
  }

  export async function resource(run: string, id: string) {
    const file = path.join(indexDir(run), `${id}.json`)
    if (!(await exists(file))) return
    return Harness.ResourceRecord.parse(await Bun.file(file).json())
  }

  export async function putResource(item: Harness.ResourceRecord) {
    await write(path.join(indexDir(item.run_id), `${item.id}.json`), item)
  }

  export async function putBody(run: string, id: string, body: string) {
    await Filesystem.write(path.join(bodyDir(run), `${id}.txt`), enc.encode(body))
  }

  export async function body(run: string, id: string) {
    const file = path.join(bodyDir(run), `${id}.txt`)
    if (!(await exists(file))) return
    return Bun.file(file).text()
  }

  export async function contextBundles(id: string) {
    return (await list(contextsDir(id), Harness.ContextBundle)).sort((a, b) => b.created_at - a.created_at)
  }

  export async function putContextBundle(item: Harness.ContextBundle) {
    await write(path.join(contextsDir(item.run_id), `${item.id}.json`), item)
  }

  export async function agentTemplates() {
    return (await list(templatesDir(), Harness.AgentTemplateRecord)).sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function putAgentTemplate(item: Harness.AgentTemplateRecord) {
    await write(path.join(templatesDir(), `${item.id}.json`), item)
  }

  export async function agentTemplate(id: string) {
    const file = path.join(templatesDir(), `${id}.json`)
    if (!(await exists(file))) return
    return Harness.AgentTemplateRecord.parse(await Bun.file(file).json())
  }

  export async function agentSessions(id: string) {
    return (await list(sessionsDir(id), Harness.AgentSessionRecord)).sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function putAgentSession(item: Harness.AgentSessionRecord) {
    await write(path.join(sessionsDir(item.run_id), `${item.id}.json`), item)
  }

  export async function summary(id: string): Promise<Harness.Summary | undefined> {
    const item = await maybeRun(id)
    if (!item) return
    return {
      run: item,
      tasks: await tasks(id),
      assignments: await assignments(id),
      artifacts: await artifacts(id),
      decisions: await decisions(id),
      events: await events(id),
      graph: await actionGraph(id),
      actions: await actions(id),
      edges: await edges(id),
      resources: await resources(id),
      contexts: await contextBundles(id),
      agent_sessions: await agentSessions(id),
    }
  }
}
