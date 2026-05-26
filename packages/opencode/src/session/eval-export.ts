import path from "path"
import { mkdir } from "fs/promises"
import { Session } from "."
import { SessionLog } from "./log"
import { SessionID } from "./schema"
import { SessionTimeline } from "./timeline"

type Data = Record<string, unknown>

type Info = Data & {
  id?: string
  role?: string
  time?: {
    created?: number
    completed?: number
    updated?: number
  }
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    total?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

type Part = Data & {
  id?: string
  type?: string
  text?: string
  tool?: string
  callID?: string
  reason?: string
  cost?: number
  tokens?: Info["tokens"]
  state?: {
    status?: string
    input?: Data
    output?: string
    error?: string
    title?: string
    metadata?: Data
    time?: {
      start?: number
      end?: number
    }
  }
}

type Msg = {
  info: Info
  parts: Part[]
}

type Log = {
  id: string
  sessionID: string
  messageID?: string
  partID?: string
  level: string
  type: string
  data: Data
  time: number
}

type Diff = Data & {
  path?: string
  file?: string
  files?: string[]
}

type Metrics = Data & {
  task: string
  system: string
  run: string
  model_turns: number
  tool_calls: number
  input_tokens: number
  output_tokens: number
  replayed_observation_tokens: number
  stored_artifact_tokens: number
  changed_files: string[]
  latency: {
    end_to_end: number
    model: number
    executor: number
    runtime: number
  }
}

export namespace SessionEval {
  export type Input = {
    task: string
    system: string
    run: string
    session: Data
    messages: Msg[]
    logs?: Log[]
    diff?: Diff[]
    timeline?: Data[]
  }

  export type Artifact = {
    name: string
    type: string
    text: string
    tokens: number
    replayed: boolean
    source: Data
  }

  export type Bundle = {
    task: string
    system: string
    run: string
    session: Data
    messages: Msg[]
    logs: Log[]
    diff: Diff[]
    timeline: Data[]
    metrics: Metrics
    final: string
    artifacts: Artifact[]
  }

  export function build(input: Input): Bundle {
    const logs = input.logs ?? []
    const diff = input.diff ?? []
    const assistant = input.messages.filter((msg) => msg.info.role === "assistant")
    const parts = input.messages.flatMap((msg) => msg.parts)
    const tools = parts.filter((part) => part.type === "tool")
    const done = tools.filter((part) => part.state?.status === "completed" || part.state?.status === "error")
    const steps = parts.filter((part) => part.type === "step-finish")
    const artifacts = done
      .map((part, i) => artifact(part, i))
      .filter((item): item is Artifact => item !== undefined)
    const replay = sumlog(logs, "eval.observation.replay", "replayed") || sum(artifacts.map((item) => item.tokens))
    const stored = sumlog(logs, "eval.artifact.store", "artifact")
    const created = time(input.session, "created")
    const updated = time(input.session, "updated")
    const changed = diff.flatMap((item) => item.files ?? [item.path ?? item.file].filter((file): file is string => !!file))

    return {
      task: input.task,
      system: input.system,
      run: input.run,
      session: input.session,
      messages: input.messages,
      logs,
      diff,
      timeline: input.timeline ?? [],
      final: final(input.messages),
      artifacts,
      metrics: {
        task: input.task,
        system: input.system,
        run: input.run,
        session: input.session.id,
        model_turns: assistant.length,
        tool_calls: tools.length,
        tool_results: done.length,
        executor_actions: done.length,
        steps: steps.length,
        input_tokens: sum(assistant.map((msg) => msg.info.tokens?.input)),
        output_tokens: sum(assistant.map((msg) => msg.info.tokens?.output)),
        reasoning_tokens: sum(assistant.map((msg) => msg.info.tokens?.reasoning)),
        cache_read_tokens: sum(assistant.map((msg) => msg.info.tokens?.cache?.read)),
        cache_write_tokens: sum(assistant.map((msg) => msg.info.tokens?.cache?.write)),
        cost: sum(assistant.map((msg) => msg.info.cost)),
        replayed_observation_tokens: replay,
        stored_artifact_tokens: stored,
        changed_files: [...new Set(changed)],
        latency: {
          end_to_end: created && updated ? Math.max(0, updated - created) : 0,
          model: sum(assistant.map((msg) => span(msg.info.time))),
          executor: sum(done.map((part) => span(part.state?.time))),
          runtime: sum(steps.map((part) => span(part.state?.time))),
        },
        dsl: {
          parse_errors: logs.filter((log) => log.type === "eval.protocol.parse" && log.data.valid === false).length,
          validation_errors: logs.filter((log) => log.type === "eval.protocol.validate" && log.data.valid === false)
            .length,
          repair_attempts: logs.filter((log) => log.type === "eval.protocol.repair").length,
        },
      },
    }
  }

  export async function collect(input: {
    sessionID: string
    task: string
    system: string
    run: string
  }) {
    const id = SessionID.make(input.sessionID)
    return build({
      task: input.task,
      system: input.system,
      run: input.run,
      session: await Session.get(id),
      messages: (await Session.messages({ sessionID: id })) as Msg[],
      logs: (await SessionLog.list({ sessionID: id, limit: 5000 })) as Log[],
      diff: (await Session.diff(id)) as Diff[],
      timeline: (await SessionTimeline.list(id)) as Data[],
    })
  }

  export async function write(input: { bundle: Bundle; dir: string }) {
    await mkdir(path.join(input.dir, "artifacts"), { recursive: true })
    await Bun.write(path.join(input.dir, "session.json"), JSON.stringify(input.bundle.session, null, 2))
    await Bun.write(path.join(input.dir, "messages.json"), JSON.stringify(input.bundle.messages, null, 2))
    await Bun.write(path.join(input.dir, "logs.json"), JSON.stringify(input.bundle.logs, null, 2))
    await Bun.write(path.join(input.dir, "timeline.json"), JSON.stringify(input.bundle.timeline, null, 2))
    await Bun.write(path.join(input.dir, "diff.json"), JSON.stringify(input.bundle.diff, null, 2))
    await Bun.write(path.join(input.dir, "metrics.json"), JSON.stringify(input.bundle.metrics, null, 2))
    await Bun.write(path.join(input.dir, "final.md"), input.bundle.final)
    await Bun.write(path.join(input.dir, "artifacts.json"), JSON.stringify(input.bundle.artifacts, null, 2))
    await Promise.all(
      input.bundle.artifacts.map((item) => Bun.write(path.join(input.dir, "artifacts", item.name), item.text)),
    )
    return input.dir
  }

  function artifact(part: Part, i: number): Artifact | undefined {
    const text = part.state?.status === "completed" ? part.state.output : part.state?.error
    if (!text) return undefined
    return {
      name: `${String(i + 1).padStart(3, "0")}-${safe(part.tool ?? "tool")}-${safe(part.callID ?? "call")}.txt`,
      type: part.state?.status ?? "unknown",
      text,
      tokens: tokens(text),
      replayed: true,
      source: {
        part: part.id,
        tool: part.tool,
        call: part.callID,
        status: part.state?.status,
        input: part.state?.input,
      },
    }
  }

  function final(messages: Msg[]) {
    return messages
      .filter((msg) => msg.info.role === "assistant")
      .at(-1)
      ?.parts.filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n")
      .trim() ?? ""
  }

  function safe(input: string) {
    return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80)
  }

  function tokens(text: string) {
    return Math.ceil(text.length / 4)
  }

  function sum(input: Array<number | undefined>): number {
    return input.reduce<number>((total, item) => total + (Number.isFinite(item) ? (item ?? 0) : 0), 0)
  }

  function span(input?: { start?: number; end?: number; created?: number; completed?: number }) {
    const start = input?.start ?? input?.created
    const end = input?.end ?? input?.completed
    if (!start || !end) return 0
    return Math.max(0, end - start)
  }

  function time(input: Data, key: "created" | "updated") {
    const value = input.time
    if (!value || typeof value !== "object") return 0
    const data = value as Record<string, unknown>
    return typeof data[key] === "number" ? data[key] : 0
  }

  function sumlog(logs: Log[], type: string, key: string) {
    return sum(
      logs.filter((log) => log.type === type).map((log) => {
        const value = log.data.tokens
        if (!value || typeof value !== "object") return typeof log.data[key] === "number" ? log.data[key] : undefined
        const tokens = value as Record<string, unknown>
        return typeof tokens[key] === "number" ? tokens[key] : undefined
      }),
    )
  }
}
