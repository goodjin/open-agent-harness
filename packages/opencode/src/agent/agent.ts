import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, values } from "remeda"
import { Plugin } from "@/plugin-stub"
import { getRegistry } from "./registry"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  /**
   * Build a PermissionNext.Ruleset from allowed_tools and denied_tools arrays.
   * This is a best-effort conversion - the original config had glob patterns,
   * but templates only have tool names, so we use "*" as the pattern.
   */
  function buildPermission(allowed: string[] | undefined, denied: string[] | undefined): PermissionNext.Ruleset {
    const rules: PermissionNext.Ruleset = []
    const whitelistedDirs = [Truncate.GLOB]

    // Default rules
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })

    // Start with defaults
    rules.push(...defaults)

    // Add deny rules for denied_tools
    if (denied) {
      for (const tool of denied) {
        rules.push({ permission: tool, action: "deny", pattern: "*" })
      }
    }

    // Ensure Truncate.GLOB is allowed unless explicitly denied
    const hasExplicitTruncateDeny = denied?.includes("external_directory")
    if (!hasExplicitTruncateDeny) {
      rules.push(...PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }))
    }

    return rules
  }

  /**
   * Convert workflow_mode to old mode format.
   * - "auto" agents can act as primary (they run without user approval)
   * - "manual" and "supervision" agents require user interaction
   */
  function workflowModeToMode(workflowMode: string | undefined): Info["mode"] {
    if (workflowMode === "manual" || workflowMode === "supervision") return "all"
    return "primary"
  }

  /**
   * Transform AgentTemplateInfo to Agent.Info
   */
  function transformToInfo(template: { id: string; name: string; meta: { description?: string; model_preference?: { providerID: string; modelID: string }; workflow_mode?: string; allowed_tools?: string[]; denied_tools?: string[] } }): Info {
    return {
      name: template.id,
      description: template.meta.description,
      mode: workflowModeToMode(template.meta.workflow_mode),
      permission: buildPermission(template.meta.allowed_tools, template.meta.denied_tools),
      options: {},
      model: template.meta.model_preference
        ? {
            providerID: ProviderID.make(template.meta.model_preference.providerID),
            modelID: ModelID.make(template.meta.model_preference.modelID),
          }
        : undefined,
    }
  }

  export async function get(agent: string): Promise<Info | undefined> {
    const registry = getRegistry()
    const template = await registry.get(agent)
    if (!template) return undefined
    return transformToInfo(template)
  }

  export async function list() {
    const registry = getRegistry()
    const agents = await registry.list()

    return agents.map((a) => {
      const template = { id: a.id, name: a.name, meta: { description: a.description, workflow_mode: a.mode } }
      return transformToInfo(template)
    })
  }

  export async function defaultAgent() {
    const registry = getRegistry()
    const effective = await registry.getEffectiveAgent()
    if (!effective) return undefined
    if (effective.meta.workflow_mode !== "auto") {
      throw new Error(`default agent "${effective.id}" is not an auto agent`)
    }
    return effective.id
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
