# 上下文、Memory 与 Visibility 策略

## 目的

本文定义 Harness 如何控制 Agent 接收什么信息、存储什么信息、向模型回放什么信息，以及什么信息对用户可见。

## 核心规则

Runtime 构造上下文。Agent 默认不接收完整原始 transcript。

```txt
Projection + Memory Service + Artifact refs -> Context Bundle -> Assignment
```

## Context Bundle 上下文包

Assignment context bundle 应包含：

```json
{
  "id": "ctx_123",
  "goal": "Review the changed protocol schema.",
  "included": [
    "file:docs/harness-protocol/02-model-runtime-protocol.md",
    "artifact:protocol_diff"
  ],
  "excluded": [
    "raw transcripts from unrelated child sessions",
    "superseded memory records"
  ],
  "summary": "The protocol supports toolCall carriers and runtime recovery.",
  "memory_refs": ["mem_protocol_policy"],
  "projection_refs": ["runtime://runs/run_123/projections/task-state"]
}
```

## Memory 作用域

Memory record 必须声明 scope：

- `run`
- `project`
- `team`
- `global`

Scope precedence 必须明确。当前 Projection 覆盖 historical memory。Project memory 可以在 project scope 内覆盖 team/global preferences。

## 数据可见性

每个 Action result 都应分类 visibility：

| Channel | 含义 |
|---|---|
| `model` | 回放到未来模型上下文。 |
| `user` | 展示在 UI 或最终回答中。 |
| `logs` | 为 audit/export 存储。 |
| `trace` | 进入 Trace summary 或 trace export。 |
| `future_runs` | 作为 memory/reference 可供后续 run 使用。 |
| `runtime_only` | 用于控制决策，默认不暴露。 |

默认策略：

- 模型接收 summary 和 refs
- 用户接收简洁 progress/result projection
- logs 存储完整结构化 trace，并受 redaction 约束
- future runs 接收 curated memory，而不是 raw logs

## 结果粒度

允许的返回模式：

- `summary`
- `structured`
- `full`
- `on_failure`
- `on_demand`
- `adaptive`

Runtime 可以出于 privacy、safety 或 context budget 原因，将模型可见结果降级到低于请求粒度。Runtime 不能超出策略提升 visibility。

## 隐私与脱敏

在回放或导出数据前，Runtime 应检查：

- secrets
- credentials
- private keys
- personal data
- proprietary external content
- 包含敏感路径或 token 的 raw command output

Redaction policy 必须一致应用于 tool output、protocol logs、workflow artifacts 和 UI exports。

## Shell 与自动 Action

自动 shell execution record 可以在 UI 中可见，同时默认被模型上下文忽略。这与 Harness context isolation 一致：timeline 中可见的输出不会自动成为模型可见上下文。

如果用户明确把 shell output 加入上下文，Runtime 应创建普通 context record，并附带 source refs 和 visibility metadata。

## 协议能力

Context、Memory 与 Visibility 策略覆盖以下能力：

- 使用 Context Bundle refs 构造模型输入。
- 将 protocol result 以简洁 Observation 形式回放给模型。
- 将完整 output 存储为 Artifact 或 log，并通过 refs 进入上下文。
- 为非模型可见 UI record 提供显式 visibility metadata。
- Memory query result 携带 scope、namespace、status、source、visibility 和 evidence refs。
