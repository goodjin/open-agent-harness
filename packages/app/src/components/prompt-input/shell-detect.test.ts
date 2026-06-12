import { describe, expect, test } from "bun:test"
import { isShellCommand } from "./shell-detect"

describe("isShellCommand", () => {
  test("detects common shell commands", () => {
    expect(isShellCommand("ls -la")).toBe(true)
    expect(isShellCommand("git status --short")).toBe(true)
    expect(isShellCommand("bun test src/foo.test.ts")).toBe(true)
  })

  test("detects shell operators", () => {
    expect(isShellCommand("rg foo | head")).toBe(true)
    expect(isShellCommand("npm test && bun typecheck")).toBe(true)
    expect(isShellCommand("echo hi > out.txt")).toBe(true)
  })

  test("does not classify natural language as shell", () => {
    expect(isShellCommand("帮我看看这个错误")).toBe(false)
    expect(isShellCommand("please run the tests")).toBe(false)
    expect(isShellCommand("explain git status")).toBe(false)
  })

  test("requires a shell command at the beginning", () => {
    expect(isShellCommand("帮我运行 rg foo | head")).toBe(false)
    expect(isShellCommand("please run npm test && bun typecheck")).toBe(false)
    expect(isShellCommand("content includes shell: git status")).toBe(false)
  })
})
