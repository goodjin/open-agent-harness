# 交互协议

交互协议定义 Runtime 何时暂停 Agent 执行，向用户请求确认、输入或继续判断，以及用户响应后如何恢复同一个 Session。

## Interaction 类型

当前 v2 协议中主要有三类用户交互：

- `confirm`
- `input`
- `reply`

`ask` 仍在 schema 中存在，但 v2 文档优先使用 `input` 和 `confirm` 表达用户交互。

## Confirm

`confirm` 用于需要用户批准后才能继续的操作。

常见用途：

- 确认任务计划。
- 创建或更新 Assignment。
- 批准高影响半径操作。
- 在执行工作前确认 scope、验收标准和风险。

`confirm` item 的关键字段：

```json
{
  "id": "confirm_assignment",
  "kind": "confirm",
  "prompt": "是否按以下计划开始执行？",
  "plan": "完整任务计划和验收标准",
  "assignment": {
    "op": "create",
    "target": "self"
  }
}
```

`plan` 是完整内容。`assignment` 是 runtime mutation 元数据。

## Input

`input` 用于缺少信息时向用户提问。

常见用途：

- 需求不清。
- 多个方案需要选择。
- 缺少外部约束。
- 需要用户提供账号、路径、目标环境或验收偏好。

`input` 可以是文本、单选、多选或表单。用户响应后，Runtime 把输入追加回同一个 Session，而不是创建一个新的独立任务。

## Reply

`reply` 是向用户回复并停止当前协议推进的 terminal item。它适合：

- 当前 Agent 无法继续，需要用户判断。
- 当前问题只需要解释或反馈。
- 子会话想把信息交回 parent 或 user，但不声称完成任务。

`reply` 可以产生 `SessionResult`，但通常是 `satisfying: false`。

## Pending Interaction 恢复

Runtime 需要持久化 pending confirmation 和 pending input，使页面刷新、进程重启或会话恢复后仍能继续。

当前恢复来源包括 protocol context 中的：

- `dsl_context.protocol.confirmations`
- `dsl_context.protocol.inputs`

用户响应后，Runtime 通过同一个 Session 继续执行，并把响应作为后续模型上下文的一部分。

## 接受与拒绝

用户接受 confirm：

```txt
pending confirm
  -> user accepts
  -> Runtime applies assignment mutation if present
  -> Runtime resumes Session
```

用户拒绝 confirm：

```txt
pending confirm
  -> user rejects
  -> Runtime records rejection
  -> Session resumes with rejection context
  -> Agent revises plan, asks input, replies, or stops
```

拒绝不是系统错误。它是一个用户决策事件。

## Interaction 与 SessionStatus

Pending interaction 通常会把 Session 投影为 `waiting_user`。但 `waiting_user` 只是容器状态，具体等待的是 confirm、input 还是 permission，要看 pending interaction projection。

UI 展示时应同时显示：

- Session 当前状态。
- pending interaction 类型。
- prompt。
- 关联 action / assignment。
- 可执行 command。

## Interaction 与 Assignment

Assignment gate 和 planner confirm 需要分开：

- planner confirm 是用户确认门。
- Assignment 是确认后产生或更新的任务归属对象。

有 delegation context 不代表一定有 active assignment。恢复 delegated flow 时，需要分别检查 delegation 关系、active assignment 和 pending confirm。
