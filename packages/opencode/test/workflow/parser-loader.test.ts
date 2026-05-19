import { describe, expect, test } from "bun:test"
import path from "path"
import { WorkflowFileLoader } from "../../src/workflow/loader"
import { WorkflowParser } from "../../src/workflow/parser"
import { tmpdir } from "../fixture/fixture"

describe("workflow parser and loader", () => {
  test("parses sequential and branching workflows", () => {
    const sequential = WorkflowParser.parse({
      id: "seq",
      name: "Sequential",
      steps: [{ id: "one", next: "two" }, { id: "two" }],
    })
    expect(sequential.steps[0].branches).toEqual([{ step: "two", guards: [] }])
    expect(sequential.nodes.map((node) => [node.id, node.depends_on])).toEqual([
      ["one", []],
      ["two", ["one"]],
    ])

    const branching = WorkflowParser.parse({
      id: "branch",
      name: "Branch",
      steps: [
        {
          id: "choose",
          next: [
            { step: "yes", guards: [{ type: "variable", name: "flag", equals: true }] },
            { step: "no" },
          ],
        },
        { id: "yes" },
        { id: "no" },
      ],
    })
    expect(branching.steps[0].branches.map((branch) => branch.step)).toEqual(["yes", "no"])
  })

  test("parses nodes into unified DAG nodes", () => {
    const parsed = WorkflowParser.parse({
      id: "dag",
      name: "Dag",
      nodes: [
        { id: "one", capabilities: ["frontend"] },
        { id: "two", depends_on: ["one"] },
      ],
    })

    expect(parsed.steps.map((step) => step.id)).toEqual(["one", "two"])
    expect(parsed.nodes[0].capabilities).toEqual(["frontend"])
    expect(parsed.nodes.map((node) => [node.id, node.index, node.depends_on])).toEqual([
      ["one", 0, []],
      ["two", 1, ["one"]],
    ])
    expect(parsed.nodes[0].branches).toEqual([])
  })

  test("rejects missing branch targets", () => {
    expect(() =>
      WorkflowParser.parse({
        id: "bad",
        name: "Bad",
        steps: [{ id: "one", next: "missing" }],
      }),
    ).toThrow("missing step")
  })

  test("rejects invalid DAG dependencies", () => {
    expect(() =>
      WorkflowParser.parse({
        id: "missing",
        name: "Missing",
        nodes: [{ id: "one", depends_on: ["nope"] }],
      }),
    ).toThrow("missing dependency")

    expect(() =>
      WorkflowParser.parse({
        id: "self",
        name: "Self",
        nodes: [{ id: "one", depends_on: ["one"] }],
      }),
    ).toThrow("cannot depend on itself")

    expect(() =>
      WorkflowParser.parse({
        id: "cycle",
        name: "Cycle",
        nodes: [
          { id: "one", depends_on: ["two"] },
          { id: "two", depends_on: ["one"] },
        ],
      }),
    ).toThrow("cycle")
  })

  test("discovers package and user workflows with user precedence", async () => {
    await using pkg = await tmpdir()
    await using user = await tmpdir()
    await Bun.write(
      path.join(pkg.path, "same.json"),
      JSON.stringify({
        id: "same",
        name: "Package",
        steps: [{ id: "one" }],
      }),
    )
    await Bun.write(
      path.join(user.path, "same.json"),
      JSON.stringify({
        id: "same",
        name: "User",
        steps: [{ id: "one" }],
      }),
    )
    await Bun.write(path.join(user.path, "bad.json"), "{")

    const loader = new WorkflowFileLoader(user.path, pkg.path)
    const loaded = await loader.load()

    expect(loaded.workflows).toHaveLength(1)
    expect(loaded.workflows[0].workflow.name).toBe("User")
    expect(loaded.diagnostics.some((item) => !item.valid)).toBe(true)
  })
})
