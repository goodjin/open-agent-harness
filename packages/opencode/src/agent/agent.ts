import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import { PermissionNext } from "@/permission/next"
import { Policy } from "@/permission/policy"
import { mergeDeep } from "remeda"
import { getRegistry, type AgentRegistry } from "./registry"
import { buildPolicy } from "./permission"
import { AgentTemplate as TemplateSchema } from "./schema"

export namespace Agent {
  const fallback: Record<string, string> = {
    compaction:
      "You are a session compaction specialist. Preserve the user's goal, important instructions, current state, completed work, pending work, and relevant files.",
    title: "You write compact session titles that capture the user's request in a few words.",
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      entry: TemplateSchema.Entry,
      capability: TemplateSchema.Capability,
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      policy: PermissionNext.PolicyModel.optional(),
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
   * Transform AgentTemplateInfo to Agent.Info
   */
  export function prompt(template: { meta: Pick<TemplateSchema.Meta, "role">; identity: string; rules: string }) {
    return [template.meta.role, template.identity, template.rules]
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .join("\n\n")
  }

  async function transformToInfo(template: {
    id: string
    name: string
    meta: TemplateSchema.Meta
    identity: string
    rules: string
  }): Promise<Info> {
    const policy = await buildPolicy(template.meta)
    return {
      name: template.id,
      description: template.meta.description,
      mode: TemplateSchema.mode(template.meta),
      entry: template.meta.entry,
      capability: template.meta.capability,
      hidden: template.meta.entry.hidden || template.meta.hidden,
      permission: Policy.toLegacy(policy),
      policy,
      options: {},
      prompt: prompt(template),
      model: template.meta.model_preference
        ? {
            providerID: ProviderID.make(template.meta.model_preference.providerID),
            modelID: ModelID.make(template.meta.model_preference.modelID),
          }
        : undefined,
    }
  }

  function overlay(name: string, info: Info | undefined, cfg: Config.Agent | undefined): Info | undefined {
    if (!cfg) return info
    if (cfg.disable) return undefined
    const next: Info =
      info ??
      ({
        name,
        description: cfg.description,
        mode: cfg.mode ?? "all",
        entry: cfg.mode ? TemplateSchema.EntryDefaults[cfg.mode] : TemplateSchema.EntryDefaults.all,
        capability: TemplateSchema.CapabilityDefaults,
        permission: [],
        policy: { rules: [] },
        options: {},
      } satisfies Info)
    const mode = cfg.mode ?? next.mode
    const hidden = cfg.hidden ?? next.hidden
    const entry = cfg.mode ? TemplateSchema.EntryDefaults[cfg.mode] : next.entry
    const policy = Policy.merge(
      next.policy ?? Policy.fromLegacy(next.permission, "agent"),
      Policy.fromConfig(cfg.permission ?? {}, "user"),
    )

    return {
      ...next,
      model: cfg.model ? Provider.parseModel(cfg.model) : next.model,
      variant: cfg.variant ?? next.variant,
      prompt: cfg.prompt ?? next.prompt,
      description: cfg.description ?? next.description,
      temperature: cfg.temperature ?? next.temperature,
      topP: cfg.top_p ?? next.topP,
      mode,
      color: cfg.color ?? next.color,
      hidden,
      entry: {
        ...entry,
        hidden: hidden ?? entry.hidden,
      },
      capability: next.capability,
      name: cfg.name ?? next.name,
      steps: cfg.steps ?? next.steps,
      options: mergeDeep(next.options, cfg.options ?? {}),
      permission: Policy.toLegacy(policy),
      policy,
    }
  }

  export async function get(agent: string, registry: AgentRegistry = getRegistry()): Promise<Info | undefined> {
    const template = await registry.get(agent)
    const cfg = (await Config.get()).agent?.[agent]
    if (!template) {
      const text = fallback[agent]
      if (!text) return overlay(agent, undefined, cfg)
      const base = await registry.get("default")
      if (!base) return overlay(agent, undefined, cfg)
      const info = await transformToInfo(base)
      return overlay(
        agent,
        {
          ...info,
          name: agent,
          prompt: [text, info.prompt].filter((item) => item && item.length > 0).join("\n\n"),
        },
        cfg,
      )
    }
    return overlay(agent, await transformToInfo(template), cfg)
  }

  export async function list() {
    const registry = getRegistry()
    const cfg = await Config.get()
    const agents = await registry.list()
    const ids = new Set([...agents.map((agent) => agent.id), ...Object.keys(cfg.agent ?? {})])

    return await Promise.all([...ids].map((id) => get(id))).then((items) =>
      items.filter((item): item is Info => !!item),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    if (cfg.default_agent) {
      const agent = await get(cfg.default_agent)
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (!agent.entry.primary) throw new Error(`default agent "${cfg.default_agent}" is not a primary agent`)
      if (agent.entry.hidden || agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      if (!agent.entry.default) throw new Error(`default agent "${cfg.default_agent}" is not default eligible`)
      return agent.name
    }

    const registry = getRegistry()
    const effective = await registry.getEffectiveAgent()
    if (!effective) return undefined
    if (!effective.entry.primary) throw new Error(`default agent "${effective.id}" is not a primary agent`)
    if (effective.entry.hidden || effective.meta.hidden) throw new Error(`default agent "${effective.id}" is hidden`)
    if (!effective.entry.default) throw new Error(`default agent "${effective.id}" is not default eligible`)
    return effective.id
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
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
