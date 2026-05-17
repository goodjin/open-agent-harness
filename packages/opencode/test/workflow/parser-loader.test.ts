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

  test("rejects missing branch targets", () => {
    expect(() =>
      WorkflowParser.parse({
        id: "bad",
        name: "Bad",
        steps: [{ id: "one", next: "missing" }],
      }),
    ).toThrow("missing step")
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
