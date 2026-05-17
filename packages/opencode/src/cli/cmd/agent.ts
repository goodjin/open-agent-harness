import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "../../global"
import { Agent } from "../../agent/agent"
import { Provider } from "../../provider/provider"
import { AgentRegistry, getRegistry } from "../../agent/registry"
import { AgentTemplate } from "../../agent/schema"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../util/filesystem"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import type { Argv } from "yargs"
import type { AgentTemplateStatus } from "../../agent/loader"

type AgentMode = "all" | "primary" | "subagent"

const AVAILABLE_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "list",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "todoread",
]

const AgentCreateCommand = cmd({
  command: "create",
  describe: "create a new agent",
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: "directory path to generate the agent file",
      })
      .option("description", {
        type: "string",
        describe: "what the agent should do",
      })
      .option("mode", {
        type: "string",
        describe: "agent mode",
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("tools", {
        type: "string",
        describe: `comma-separated list of tools to enable (default: all). Available: "${AVAILABLE_TOOLS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const cliPath = args.path
        const cliDescription = args.description
        const cliMode = args.mode as AgentMode | undefined
        const cliTools = args.tools

        const isFullyNonInteractive = cliPath && cliDescription && cliMode && cliTools !== undefined

        if (!isFullyNonInteractive) {
          UI.empty()
          prompts.intro("Create agent")
        }

        const project = Instance.project

        // Determine scope/path - for template-based agents, use config/agents/
        let targetPath: string
        if (cliPath) {
          targetPath = path.join(cliPath, "agents")
        } else {
          let scope: "global" | "project" = "global"
          if (project.vcs === "git") {
            const scopeResult = await prompts.select({
              message: "Location",
              options: [
                {
                  label: "Current project",
                  value: "project" as const,
                  hint: Instance.worktree,
                },
                {
                  label: "Global",
                  value: "global" as const,
                  hint: Global.Path.config,
                },
              ],
            })
            if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
            scope = scopeResult
          }
          targetPath = path.join(
            scope === "global" ? Global.Path.config : path.join(Instance.worktree, ".opencode"),
            "agents",
          )
        }

        // Get description
        let description: string
        if (cliDescription) {
          description = cliDescription
        } else {
          const query = await prompts.text({
            message: "Description",
            placeholder: "What should this agent do?",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          })
          if (prompts.isCancel(query)) throw new UI.CancelledError()
          description = query
        }

        // Generate agent
        const spinner = prompts.spinner()
        spinner.start("Generating agent configuration...")
        const model = args.model ? Provider.parseModel(args.model) : undefined
        const generated = await Agent.generate({ description, model }).catch((error) => {
          spinner.stop(`LLM failed to generate agent: ${error.message}`, 1)
          if (isFullyNonInteractive) process.exit(1)
          throw new UI.CancelledError()
        })
        spinner.stop(`Agent ${generated.identifier} generated`)

        // Select tools
        let selectedTools: string[]
        if (cliTools !== undefined) {
          selectedTools = cliTools ? cliTools.split(",").map((t) => t.trim()) : AVAILABLE_TOOLS
        } else {
          const result = await prompts.multiselect({
            message: "Select tools to enable (Space to toggle)",
            options: AVAILABLE_TOOLS.map((tool) => ({
              label: tool,
              value: tool,
            })),
            initialValues: AVAILABLE_TOOLS,
          })
          if (prompts.isCancel(result)) throw new UI.CancelledError()
          selectedTools = result
        }

        // Get mode
        let mode: AgentMode
        if (cliMode) {
          mode = cliMode
        } else {
          const modeResult = await prompts.select({
            message: "Agent mode",
            options: [
              {
                label: "All",
                value: "all" as const,
                hint: "Can function in both primary and subagent roles",
              },
              {
                label: "Primary",
                value: "primary" as const,
                hint: "Acts as a primary/main agent",
              },
              {
                label: "Subagent",
                value: "subagent" as const,
                hint: "Can be used as a subagent by other agents",
              },
            ],
            initialValue: "all" as const,
          })
          if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
          mode = modeResult
        }

        // Build tools config
        const deniedTools: string[] = []
        for (const tool of AVAILABLE_TOOLS) {
          if (!selectedTools.includes(tool)) {
            deniedTools.push(tool)
          }
        }

        // Convert mode to workflow_mode
        const workflowMode = mode === "all" ? "auto" : mode === "primary" ? "manual" : "supervision"

        // Create agent template directory
        const agentId = generated.identifier.toLowerCase().replace(/\s+/g, "-")
        const agentDir = path.join(targetPath, agentId)
        const metaPath = path.join(agentDir, "meta.json")
        const identityPath = path.join(agentDir, "identity.md")
        const rulesPath = path.join(agentDir, "rules.md")

        await fs.mkdir(agentDir, { recursive: true })

        if (await Filesystem.exists(metaPath)) {
          if (isFullyNonInteractive) {
            console.error(`Error: Agent directory already exists: ${agentDir}`)
            process.exit(1)
          }
          prompts.log.error(`Agent directory already exists: ${agentDir}`)
          throw new UI.CancelledError()
        }

        // Write meta.json
        const meta: AgentTemplate.MetaInput = {
          id: agentId,
          name: generated.identifier,
          role: generated.systemPrompt.slice(0, 200), // Use first 200 chars as role
          description: generated.whenToUse,
          workflow_mode: workflowMode as "auto" | "manual" | "supervision",
          allowed_tools: selectedTools,
          denied_tools: deniedTools,
        }
        await Filesystem.writeJson(metaPath, meta)

        // Write identity.md
        const identityContent = `# Identity

## Role Definition
${generated.systemPrompt}

## Core Responsibilities
1. **Primary Task**: ${generated.whenToUse}

## Communication Style
- Be clear and concise
- Provide actionable feedback

## Expertise Areas
- Software development
- Code review and optimization
`
        await Filesystem.write(identityPath, identityContent)

        // Write rules.md
        const rulesContent = `# Rules

## General Behavior
1. **Follow Instructions**: Always follow the user's instructions carefully
2. **Be Helpful**: Provide useful and accurate information

## Code Modification Rules
1. **Make Minimal Changes**: Only change what's necessary
2. **Preserve Functionality**: Ensure existing tests pass

## Permission Handling
1. **Ask Before Action**: Confirm destructive operations
2. **Respect Boundaries**: Don't access unauthorized resources

## Error Handling
1. **Report Clearly**: Explain errors in user-friendly terms
2. **Suggest Solutions**: Offer ways to fix issues

## Session Management
1. **Be Efficient**: Minimize unnecessary interactions
2. **Track Context**: Maintain conversation continuity
`
        await Filesystem.write(rulesPath, rulesContent)

        if (isFullyNonInteractive) {
          console.log(agentDir)
        } else {
          prompts.log.success(`Agent created: ${agentDir}`)
          prompts.outro("Done")
        }
      },
    })
  },
})

const AgentListCommand = cmd({
  command: "list",
  describe: "list all available agents",
  builder: (yargs: Argv) =>
    yargs.option("templates", {
      type: "boolean",
      describe: "list agent template paths and validation state",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const registry = getRegistry()
        if (args.templates) {
          const templates = await registry.templates()
          printTemplates(templates)
          if (templates.some((template) => !template.valid)) process.exit(1)
          return
        }

        const agents = await registry.list()
        const cfg = await import("../../config/config").then((m) => m.Config.get())
        const defaultAgent = cfg.default_agent

        const sortedAgents = agents.sort((a, b) => {
          // Default agent first
          if (a.id === defaultAgent) return -1
          if (b.id === defaultAgent) return 1
          return a.name.localeCompare(b.name)
        })

        for (const agent of sortedAgents) {
          const marker = agent.id === defaultAgent ? " (*)" : ""
          process.stdout.write(`${agent.name}${marker}` + EOL)
          process.stdout.write(`  ID: ${agent.id}` + EOL)
          process.stdout.write(`  Mode: ${agent.mode}` + EOL)
          process.stdout.write(`  Description: ${agent.description}` + EOL)
          process.stdout.write(EOL)
        }
        process.stdout.write(`${agents.length} agent(s)` + EOL)
      },
    })
  },
})

const AgentValidateCommand = cmd({
  command: "validate <path>",
  describe: "validate an agent template directory",
  builder: (yargs: Argv) =>
    yargs.positional("path", {
      type: "string",
      describe: "agent template directory, or a directory containing templates",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const registry = getRegistry()
        const templates = await registry.templates(path.resolve(String(args.path)))
        printTemplates(templates)
        if (templates.length === 0 || templates.some((template) => !template.valid)) process.exit(1)
      },
    })
  },
})

function printTemplates(templates: AgentTemplateStatus[]) {
  for (const template of templates) {
    process.stdout.write(`${template.valid ? "valid" : "invalid"} ${template.source} ${template.dir}` + EOL)
    if (template.id) process.stdout.write(`  ID: ${template.id}` + EOL)
    for (const error of template.errors) process.stdout.write(`  Error: ${error}` + EOL)
  }
  process.stdout.write(`${templates.length} template(s)` + EOL)
}

export const AgentCommand = cmd({
  command: "agent",
  describe: "manage agents",
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).command(AgentValidateCommand).demandCommand(),
  async handler() {},
})
