#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const globs = [
  "packages/sdk/openapi.json",
  "packages/sdk/js/openapi.json",
  "packages/sdk/js/src/gen/**/*.ts",
  "packages/sdk/js/src/v2/gen/**/*.ts",
  "packages/sdk/js/dist/**/*",
]
function sdk(file: string) {
  if (file === "packages/sdk/openapi.json") return true
  return file.startsWith("packages/sdk/js/src/v2/gen/")
}

async function list() {
  return (
    await Promise.all(
      globs.map(async (glob) => Array.fromAsync(new Bun.Glob(glob).scan({ cwd: root, onlyFiles: true }))),
    )
  )
    .flat()
    .filter((file, index, array) => array.indexOf(file) === index)
    .sort()
}

async function snap(files: string[]) {
  return Promise.all(
    files.map(async (file) => ({
      file,
      data: await Bun.file(path.join(root, file)).arrayBuffer(),
    })),
  )
}

async function restore(snaps: Awaited<ReturnType<typeof snap>>) {
  const keep = new Set(snaps.map((item) => item.file))
  await Promise.all(
    (await list())
      .filter((file) => !keep.has(file))
      .map((file) => $`rm -f ${path.join(root, file)}`.quiet()),
  )
  await Promise.all(
    snaps.map(async (item) => {
      await $`mkdir -p ${path.dirname(path.join(root, item.file))}`.quiet()
      await Bun.write(path.join(root, item.file), item.data)
    }),
  )
}

async function current(files: string[]) {
  return new Map(
    await Promise.all(files.map(async (file) => [file, await Bun.file(path.join(root, file)).text()] as const)),
  )
}

async function assert() {
  const spec = (await Bun.file(path.join(root, "packages/sdk/openapi.json")).json()) as {
    paths?: Record<string, unknown>
    components?: { schemas?: Record<string, unknown> }
  }
  if (!spec.paths?.["/audit"]) throw new Error("packages/sdk/openapi.json is missing /audit")
  if (!spec.components?.schemas?.AuditRecord) throw new Error("packages/sdk/openapi.json is missing AuditRecord")
  if (!spec.components?.schemas?.AuditEvent) throw new Error("packages/sdk/openapi.json is missing AuditEvent")
  if (!spec.components?.schemas?.AuditEventType) throw new Error("packages/sdk/openapi.json is missing AuditEventType")
}

const before = await list()
const snaps = await snap(before)
const files = before.filter(sdk)
const saved = await current(files)

try {
  await assert()
  await $`bun ./packages/sdk/js/script/build.ts`.cwd(root)
  await assert()
  const after = (await list()).filter(sdk)
  const built = await current(after)
  const stale = Array.from(new Set([...files, ...after])).filter((file) => saved.get(file) !== built.get(file))
  if (stale.length > 0) throw new Error(`SDK/OpenAPI generated files are stale:\n${stale.join("\n")}`)
} finally {
  await restore(snaps)
}
