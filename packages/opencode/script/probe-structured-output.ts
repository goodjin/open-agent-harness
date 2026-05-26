#!/usr/bin/env bun
import { Output, generateObject, generateText, jsonSchema, tool } from "ai"
import z from "zod"
import { bootstrap } from "../src/cli/bootstrap"
import { Config } from "../src/config/config"
import { Provider } from "../src/provider/provider"

const args = new Map(
  process.argv.slice(2).flatMap((item, idx, all) => {
    if (!item.startsWith("--")) return []
    const [key, inline] = item.slice(2).split("=", 2)
    return [[key, inline ?? all[idx + 1] ?? "true"]]
  }),
)

const target = args.get("model") ?? "minimax-cn-coding-plan/MiniMax-M2.7-highspeed"
const dir = args.get("dir") ?? "/Users/jin/github/htmly"
const parsed = Provider.parseModel(target)
const schema = z
  .object({
    type: z.literal("probe"),
    ok: z.boolean(),
    note: z.string(),
  })
  .strict()

type Probe = {
  name: string
  ok: boolean
  detail: unknown
}

function text(err: unknown) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      cause: err.cause instanceof Error ? { name: err.cause.name, message: err.cause.message } : err.cause,
    }
  }
  return err
}

async function run(name: string, fn: () => Promise<unknown>): Promise<Probe> {
  const start = Date.now()
  try {
    const detail = await fn()
    return { name, ok: true, detail: { ms: Date.now() - start, ...((detail ?? {}) as object) } }
  } catch (err) {
    return { name, ok: false, detail: { ms: Date.now() - start, error: text(err) } }
  }
}

await bootstrap(dir, async () => {
  await Config.waitForDependencies()

  const model = await Provider.getModel(parsed.providerID, parsed.modelID)
  const language = await Provider.getLanguage(model)
  const provider = await Provider.getProvider(parsed.providerID)
  const prompt = [
    "Return this exact semantic object and nothing else:",
    '{ "type": "probe", "ok": true, "note": "structured-output-supported" }',
  ].join("\n")

  console.log(
    JSON.stringify(
      {
        target,
        directory: dir,
        provider: {
          id: provider.id,
          name: provider.name,
          source: provider.source,
          options: Object.keys(provider.options ?? {}),
        },
        model: {
          id: model.id,
          api: model.api,
          capabilities: model.capabilities,
          options: Object.keys(model.options ?? {}),
        },
      },
      null,
      2,
    ),
  )

  const probes = await Promise.all([
    run("plain-json-prompt", async () => {
      const result = await generateText({
        model: language,
        prompt,
        maxRetries: 0,
      })
      const raw = result.text.trim()
      const parsed = schema.safeParse(JSON.parse(raw))
      return {
        parsed: parsed.success,
        raw,
        warnings: result.warnings,
        finishReason: result.finishReason,
      }
    }),

    run("generate-object-schema", async () => {
      const result = await generateObject({
        model: language,
        schema,
        schemaName: "StructuredProbe",
        schemaDescription: "Minimal probe for native structured output support.",
        prompt,
        maxRetries: 0,
      })
      return {
        object: result.object,
        warnings: result.warnings,
        finishReason: result.finishReason,
      }
    }),

    run("generate-text-experimental-output", async () => {
      const result = await generateText({
        model: language,
        prompt,
        experimental_output: Output.object({ schema }),
        maxRetries: 0,
      })
      return {
        output: result.experimental_output,
        text: result.text,
        warnings: result.warnings,
        finishReason: result.finishReason,
      }
    }),

    run("structured-output-tool", async () => {
      let captured: unknown
      const result = await generateText({
        model: language,
        prompt: [
          "Call StructuredProbe exactly once with this object:",
          '{ "type": "probe", "ok": true, "note": "structured-output-tool-supported" }',
        ].join("\n"),
        tools: {
          StructuredProbe: tool({
            description: "Capture a structured probe object.",
            inputSchema: jsonSchema({
              type: "object",
              additionalProperties: false,
              required: ["type", "ok", "note"],
              properties: {
                type: { const: "probe" },
                ok: { type: "boolean" },
                note: { type: "string" },
              },
            }),
            execute: async (input) => {
              captured = input
              return { ok: true }
            },
          }),
        },
        toolChoice: { type: "tool", toolName: "StructuredProbe" },
        maxRetries: 0,
      })
      return {
        captured,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        text: result.text,
        warnings: result.warnings,
        finishReason: result.finishReason,
      }
    }),
  ])

  console.log(JSON.stringify({ probes }, null, 2))
})
