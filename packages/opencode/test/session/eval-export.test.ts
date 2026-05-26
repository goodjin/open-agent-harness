import { describe, expect, test } from "bun:test"
import { SessionEval } from "../../src/session/eval-export"

describe("session eval export", () => {
  test("builds metrics from messages, tool parts, logs, and diff", () => {
    const bundle = SessionEval.build({
      task: "T03",
      system: "dsl",
      run: "run-001",
      session: {
        id: "ses_test",
        title: "Eval session",
        time: {
          created: 1000,
          updated: 5000,
        },
      },
      messages: [
        {
          info: {
            id: "msg_user",
            role: "user",
            sessionID: "ses_test",
            time: {
              created: 1000,
            },
          },
          parts: [
            {
              id: "prt_user",
              sessionID: "ses_test",
              messageID: "msg_user",
              type: "text",
              text: "Fix the schema validator.",
            },
          ],
        },
        {
          info: {
            id: "msg_assistant",
            role: "assistant",
            sessionID: "ses_test",
            parentID: "msg_user",
            modelID: "gpt-test",
            providerID: "test",
            mode: "",
            agent: "build",
            path: {
              cwd: "/repo",
              root: "/repo",
            },
            time: {
              created: 1200,
              completed: 4200,
            },
            cost: 0.02,
            tokens: {
              input: 100,
              output: 40,
              reasoning: 10,
              cache: {
                read: 5,
                write: 2,
              },
            },
          },
          parts: [
            {
              id: "prt_step",
              sessionID: "ses_test",
              messageID: "msg_assistant",
              type: "step-finish",
              reason: "tool-calls",
              cost: 0.01,
              tokens: {
                input: 20,
                output: 10,
                reasoning: 0,
                cache: {
                  read: 0,
                  write: 0,
                },
              },
            },
            {
              id: "prt_tool",
              sessionID: "ses_test",
              messageID: "msg_assistant",
              type: "tool",
              callID: "call_test",
              tool: "bash",
              state: {
                status: "completed",
                input: {
                  command: "bun test",
                },
                output: "failed test output with useful details",
                title: "Run tests",
                metadata: {},
                time: {
                  start: 1500,
                  end: 2500,
                },
              },
            },
            {
              id: "prt_text",
              sessionID: "ses_test",
              messageID: "msg_assistant",
              type: "text",
              text: "Fixed the schema validator.",
            },
          ],
        },
      ],
      logs: [
        {
          id: "log_art",
          sessionID: "ses_test",
          level: "info",
          type: "eval.artifact.store",
          time: 2000,
          data: {
            tokens: {
              artifact: 50,
            },
          },
        },
        {
          id: "log_obs",
          sessionID: "ses_test",
          level: "info",
          type: "eval.observation.replay",
          time: 2100,
          data: {
            tokens: {
              replayed: 7,
            },
          },
        },
      ],
      diff: [
        {
          path: "src/schema.ts",
          added: 3,
          removed: 1,
        },
      ],
    })

    expect(bundle.metrics.task).toBe("T03")
    expect(bundle.metrics.system).toBe("dsl")
    expect(bundle.metrics.model_turns).toBe(1)
    expect(bundle.metrics.tool_calls).toBe(1)
    expect(bundle.metrics.input_tokens).toBe(100)
    expect(bundle.metrics.output_tokens).toBe(40)
    expect(bundle.metrics.replayed_observation_tokens).toBe(7)
    expect(bundle.metrics.stored_artifact_tokens).toBe(50)
    expect(bundle.metrics.latency.model).toBe(3000)
    expect(bundle.metrics.latency.executor).toBe(1000)
    expect(bundle.metrics.changed_files).toEqual(["src/schema.ts"])
    expect(bundle.final).toBe("Fixed the schema validator.")
    expect(bundle.artifacts.some((item) => item.name.includes("bash"))).toBe(true)
  })
})
