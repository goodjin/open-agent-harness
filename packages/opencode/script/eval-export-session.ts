#!/usr/bin/env bun
import path from "path"
import { bootstrap } from "../src/cli/bootstrap"
import { SessionEval } from "../src/session/eval-export"

type Args = {
  session?: string
  task?: string
  system?: string
  run?: string
  out?: string
  cwd?: string
}

const args = parse(process.argv.slice(2))

if (!args.session || !args.task || !args.system || !args.run || !args.out) {
  process.stderr.write(
    [
      "Usage:",
      "  bun run script/eval-export-session.ts --session <sessionID> --task <taskID> --system <system> --run <runID> --out <dir> [--cwd <repo>]",
      "",
    ].join("\n"),
  )
  process.exit(1)
}

await bootstrap(args.cwd ?? process.cwd(), async () => {
  const bundle = await SessionEval.collect({
    sessionID: args.session!,
    task: args.task!,
    system: args.system!,
    run: args.run!,
  })
  const dir = path.resolve(args.out!)
  await SessionEval.write({ bundle, dir })
  process.stdout.write(`${dir}\n`)
})

function parse(input: string[]) {
  const args: Args = {}
  for (let i = 0; i < input.length; i++) {
    const key = input[i]
    const value = input[i + 1]
    if (!key?.startsWith("--") || !value || value.startsWith("--")) continue
    if (key === "--session") args.session = value
    if (key === "--task") args.task = value
    if (key === "--system") args.system = value
    if (key === "--run") args.run = value
    if (key === "--out") args.out = value
    if (key === "--cwd") args.cwd = value
    i++
  }
  return args
}
