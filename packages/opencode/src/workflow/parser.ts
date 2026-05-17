import { Workflow } from "./schema"

export namespace WorkflowParser {
  export type Branch = Workflow.Branch
  export type Step = Workflow.Step & {
    branches: Branch[]
    index: number
  }
  export type Definition = Omit<Workflow.Definition, "steps"> & {
    steps: Step[]
  }

  function branches(step: Workflow.Step, next: string | Workflow.Branch[] | undefined): Branch[] {
    if (typeof next === "string") return [{ step: next, guards: [] }]
    if (next) return next
    return []
  }

  export function parse(input: unknown): Definition {
    const workflow = Workflow.Definition.parse(input)
    const ids = new Set(workflow.steps.map((step) => step.id))
    const steps = workflow.steps.map((step, index) => ({
      ...step,
      index,
      branches: branches(step, step.next),
    }))

    for (const step of steps) {
      for (const branch of step.branches) {
        if (ids.has(branch.step)) continue
        throw new Error(`Workflow ${workflow.id} step ${step.id} points to missing step ${branch.step}`)
      }
    }

    return {
      ...workflow,
      steps,
    }
  }
}
