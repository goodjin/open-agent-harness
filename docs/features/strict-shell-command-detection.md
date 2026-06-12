# Strict Shell Command Detection

## User Goal

Chat input should only auto-enter shell execution when the message starts with a shell command. Natural language that merely contains shell words, pipes, redirects, or command examples should stay a normal chat prompt.

## Agreed Scope

- Tighten automatic shell detection used by the app prompt input.
- Keep explicit shell mode behavior unchanged.
- Keep common command starts such as `git status`, `rg foo | head`, and `npm test && bun typecheck` auto-detected.
- Do not classify text as shell only because it contains shell syntax later in the message.

## Implementation Plan

- Add regression coverage for natural-language prompts that contain shell snippets.
- Update `isShellCommand()` so detection is anchored to the first meaningful token after trimming whitespace.
- Keep environment-assignment command starts such as `FOO=bar npm test` as shell commands.

## Affected Modules

- `packages/app/src/components/prompt-input/shell-detect.ts`
- `packages/app/src/components/prompt-input/shell-detect.test.ts`
- `docs/harness-module/ui-console.md`

## Verification Plan

- Run the focused shell detection test from `packages/app`.
- Run `bun typecheck` from `packages/app` if the focused test passes.
