import { Workflow } from "./schema"

export namespace WorkflowParser {
  export type Branch = Workflow.Branch
  export type Step = Omit<Workflow.Node, "depends_on"> & {
    branches: Branch[]
    depends_on: string[]
    index: number
    next?: Workflow.Step["next"]
  }
  export type Definition = Omit<Workflow.Definition, "steps" | "nodes"> & {
    legacy: boolean
    steps: Step[]
    nodes: Step[]
  }

  function branches(step: Workflow.Step, next: string | Workflow.Branch[] | undefined): Branch[] {
    if (typeof next === "string") return [{ step: next, guards: [] }]
    if (next) return next
    return []
  }

  function legacy(steps: Workflow.Step[]) {
    const deps = new Map(steps.map((step) => [step.id, [] as string[]]))
    const refs = new Set(steps.flatMap((step) => step.verification?.must_pass ?? []))

    for (const [index, step] of steps.entries()) {
      const list = branches(step, step.next)
      if (list.length > 0) {
        for (const branch of list) deps.get(branch.step)?.push(step.id)
        continue
      }
      const next = steps[index + 1]
      if (next && (deps.get(next.id)?.length ?? 0) === 0) deps.get(next.id)?.push(step.id)
    }

    for (const step of steps) {
      if (!refs.has(step.id)) continue
      const current = deps.get(step.id) ?? []
      if (current.length > 0) continue
      deps.set(
        step.id,
        steps.filter((item) => item.id !== step.id && !refs.has(item.id)).map((item) => item.id),
      )
    }

    return steps.map((step, index) => ({
      ...step,
      index,
      branches: branches(step, step.next),
      depends_on: [...new Set(deps.get(step.id) ?? [])],
    }))
  }

  function modern(nodes: Workflow.Node[]) {
    return nodes.map((node, index) => ({
      ...node,
      index,
      branches: [],
      next: undefined,
      depends_on: [...new Set(node.depends_on)],
    }))
  }

  function validate(workflow: Definition) {
    const ids = new Set<string>()
    const nodes = new Map<string, Step>()
    for (const node of workflow.nodes) {
      if (ids.has(node.id)) throw new Error(`Workflow ${workflow.id} has duplicate node id: ${node.id}`)
      ids.add(node.id)
      nodes.set(node.id, node)
    }

    for (const node of workflow.nodes) {
      for (const branch of node.branches) {
        if (ids.has(branch.step)) continue
        throw new Error(`Workflow ${workflow.id} step ${node.id} points to missing step ${branch.step}`)
      }
      for (const dep of node.depends_on) {
        if (dep === node.id) throw new Error(`Workflow ${workflow.id} node ${node.id} cannot depend on itself`)
        if (ids.has(dep)) continue
        throw new Error(`Workflow ${workflow.id} node ${node.id} has missing dependency ${dep}`)
      }
      for (const ref of node.verification?.must_pass ?? []) {
        const target = nodes.get(ref)
        if (!target) throw new Error(`Workflow ${workflow.id} node ${node.id} references missing verification node ${ref}`)
        if (!["test", "review", "gate"].includes(target.type)) {
          throw new Error(`Workflow ${workflow.id} node ${node.id} verification target ${ref} must be test, review, or gate`)
        }
      }
    }

    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (node: Step): void => {
      if (done.has(node.id)) return
      if (visiting.has(node.id)) throw new Error(`Workflow ${workflow.id} contains a dependency cycle at ${node.id}`)
      visiting.add(node.id)
      for (const dep of node.depends_on) visit(nodes.get(dep)!)
      visiting.delete(node.id)
      done.add(node.id)
    }
    for (const node of workflow.nodes) visit(node)
  }

  export function parse(input: unknown): Definition {
    const workflow = Workflow.Definition.parse(input)
    const nodes = workflow.nodes.length > 0 ? modern(workflow.nodes) : legacy(workflow.steps)
    const parsed = {
      ...workflow,
      legacy: workflow.nodes.length === 0,
      steps: nodes,
      nodes,
    }
    validate(parsed)
    return parsed
  }
}
