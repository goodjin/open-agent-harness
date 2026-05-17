#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))
await Bun.write(path.resolve(dir, "../openapi.json"), await Bun.file(path.join(dir, "openapi.json")).text())

async function patch() {
  const sdk = path.join(dir, "src/v2/gen/sdk.gen.ts")
  const text = await Bun.file(sdk).text()
  const swap = (input: string, from: string, to: string, name: string) => {
    const count = input.split(from).length - 1
    if (count !== 1) throw new Error(`${name} required-param patch expected 1 match, found ${count}`)
    return input.replace(from, to)
  }
  const run = swap(
    text,
    `  public run<ThrowOnError extends boolean = false>(
    parameters?: {
      directory?: string
      sessionID?: string
      workflowID?: string`,
    `  public run<ThrowOnError extends boolean = false>(
    parameters: {
      directory?: string
      sessionID: string
      workflowID: string`,
    "workflow run",
  )
  await Bun.write(
    sdk,
    swap(
      run,
      `  public resume<ThrowOnError extends boolean = false>(
    parameters?: {
      directory?: string
      sessionID?: string`,
      `  public resume<ThrowOnError extends boolean = false>(
    parameters: {
      directory?: string
      sessionID: string`,
      "workflow resume",
    ),
  )
}

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await patch()
await $`bun prettier --write src/v2/gen/sdk.gen.ts`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
