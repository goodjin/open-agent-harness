import path from "path"
import { ConfigPaths } from "@/config/paths"
import { Glob } from "@/util/glob"
import { Instance } from "@/project/instance"
import { WorkflowParser } from "./parser"

export type WorkflowSource = "package" | "user"

export type WorkflowEntry = {
  path: string
  source: WorkflowSource
  workflow: WorkflowParser.Definition
}

export type WorkflowDiagnostic = {
  path: string
  source: WorkflowSource
  id?: string
  valid: boolean
  errors: string[]
}

type Loaded = {
  entry?: WorkflowEntry
  diagnostic: WorkflowDiagnostic
}

export class WorkflowFileLoader {
  private dirs: string[]
  private fallback: string

  constructor(dirs?: string | string[], fallback?: string) {
    this.dirs = [dirs ?? []].flat().filter((dir) => dir.length > 0)
    this.fallback = fallback ?? path.join(import.meta.dir, "..", "..", "config", "workflows")
  }

  async load() {
    const map = new Map<string, WorkflowEntry>()
    const diagnostics: WorkflowDiagnostic[] = []

    for (const item of await this.dir(this.fallback, "package")) {
      if (item.entry) map.set(item.entry.workflow.id, item.entry)
      diagnostics.push(item.diagnostic)
    }
    for (const dir of this.dirs) {
      for (const item of await this.dir(dir, "user")) {
        if (item.entry) map.set(item.entry.workflow.id, item.entry)
        diagnostics.push(item.diagnostic)
      }
    }

    return {
      workflows: [...map.values()].sort((a, b) => a.workflow.id.localeCompare(b.workflow.id)),
      diagnostics,
    }
  }

  async get(id: string) {
    return (await this.load()).workflows.find((item) => item.workflow.id === id)
  }

  private async files(dir: string) {
    const json = await Glob.scan("*.json", { cwd: dir, absolute: true }).catch(() => [])
    const jsonc = await Glob.scan("*.jsonc", { cwd: dir, absolute: true }).catch(() => [])
    return [...json, ...jsonc].sort()
  }

  private async dir(dir: string, source: WorkflowSource): Promise<Loaded[]> {
    return Promise.all((await this.files(dir)).map((file) => this.file(file, source)))
  }

  private async file(file: string, source: WorkflowSource): Promise<Loaded> {
    return Bun.file(file)
      .text()
      .then(async (text) => {
        const data = await ConfigPaths.parseText(text, { source: file, dir: path.dirname(file) })
        const workflow = WorkflowParser.parse(data)
        return {
          entry: {
            path: file,
            source,
            workflow,
          },
          diagnostic: {
            path: file,
            source,
            id: workflow.id,
            valid: true,
            errors: [],
          },
        }
      })
      .catch((err) => ({
        diagnostic: {
          path: file,
          source,
          valid: false,
          errors: [err instanceof Error ? err.message : String(err)],
        },
      }))
  }
}

export async function loader() {
  const dirs = await ConfigPaths.directories(Instance.directory, Instance.worktree)
  return new WorkflowFileLoader(dirs.map((dir) => path.join(dir, "workflows")))
}
