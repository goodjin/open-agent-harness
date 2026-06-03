# Open Agent Harness

Open Agent Harness 是一个以 Agent 为基本单元的运行时设计项目。

它关注的不是“如何再包装一个聊天模型”，而是把模型、工具、上下文、状态和多个 Agent 的协作放进同一套可控制的运行环境里。模型负责判断和声明意图，Runtime 负责构造环境、校验边界、调度执行、记录事实，并在需要时组织多个 Agent 接力完成任务。

## 设计思路

Open Agent Harness 当前围绕四条主线推进：

- 以 Agent 作为基本治理单位。系统不再保留 Skill 作为运行时概念，每个任务都由 Agent 完成；一个 Agent 只做一件事，用清晰的职责、入口、权限和交付边界换取可管理性。
- 重新设计模型与 Runtime 的交互协议，让模型声明意图，Runtime 掌握执行权。由于模型和 Runtime 的特性不同，输入和输出格式也应不同，以适配各自的特点。
- 丰富 Runtime 能力，为模型构建上下文、状态、工具、记忆、artifact 和恢复环境。
- 设计多 Agent 控制协议，让委托、交接、审查、失败恢复和人工决策都能被记录和治理。

## 核心问题

大模型已经能写代码、读文件、调用工具，也能临时扮演不同角色。但在复杂任务里，问题很快会从“模型会不会做”变成：

- 模型看到的上下文是否完整、是否相关？
- 工具调用是否有权限、边界和可追溯记录？
- 一个 Agent 的结果如何交给另一个 Agent，而不是靠自由文本接着聊？
- 多个 Agent 并行或串行时，谁负责状态、依赖、失败恢复和最终验收？

Open Agent Harness 的设计就是围绕这些问题展开。

## Agent 作为基本单元

在 Open Agent Harness 中，Agent 不是一段 prompt，也不是一个临时角色名。Agent 是 Runtime 可以管理、路由、授权和观察的执行单元。

Open Agent Harness 取消 Skill 作为运行时概念。系统里的任务由 Agent 承接，Agent 是最小治理单位。基本理念很直接：一个 Agent 只做一件事。如果一个任务需要开发、验证、审查、发布准备，就拆成多个职责明确的 Agent，由 Runtime 组织它们协作。

一个 Agent 至少表达四类信息：

- 它是谁：身份、职责、行为风格和适用场景。
- 它能做什么：能力标签、任务类型、成本倾向和是否倾向写入。
- 它能被怎样使用：能否作为主 Agent、能否被委托、能否被用户显式调用。
- 它在执行时受什么限制：工具边界、权限模式、上下文来源和交付要求。

这样做的目的，是让 Agent 足够小、足够明确，也足够可治理。Runtime 不需要猜一个大而泛的 Agent 此刻到底在扮演什么角色，它只需要根据任务目标选择合适的 Agent，并为这次 Assignment 构造上下文、权限和交付契约。

## 重新设计模型与 Runtime 的交互协议

传统工具调用更像模型直接抛出一组动作：读文件、运行命令、调用工具。Open Agent Harness 更希望模型输出的是可解释的执行意图。

模型不直接拥有系统状态，也不直接决定副作用能否发生。它通过协议告诉 Runtime：

- 我想做哪些动作。
- 哪些动作可以并行，哪些动作依赖上游结果。
- 我希望结果以摘要、结构化数据还是完整产物的方式返回。
- 失败、阻塞、需要审批或需要交接时应该如何处理。

Runtime 接收这些声明后，再归一化成 Action Graph，执行校验、权限判断、路由、记录、投影和恢复。

一个简化例子：

```json
{
  "kind": "act",
  "message": "先检查实现和测试，再交给审查 Agent 判断风险。",
  "calls": [
    {
      "id": "read_code",
      "type": "tool",
      "name": "read",
      "args": { "path": "src/runtime.ts" },
      "result": "summary"
    },
    {
      "id": "review",
      "type": "agent",
      "name": "technical_reviewer",
      "depends_on": "read_code",
      "args": { "goal": "Review runtime protocol boundary." },
      "result": "structured"
    }
  ]
}
```

这里模型声明的是意图和依赖。是否允许读取、由哪个 executor 执行、结果如何进入上下文、审查结果如何保存，都由 Runtime 决定。

## Runtime 为模型构建更完整的执行环境

模型本身没有长期状态，也不天然知道哪些信息该看、哪些信息该忽略。Runtime 的能力需要从“工具转发器”扩展为“执行环境构造者”。

Open Agent Harness 中的 Runtime 负责：

- 构造 Context Bundle：把用户目标、当前状态、相关记忆、artifact、约束和历史证据组织成模型可用输入。
- 管理 Action Graph：保存依赖关系、执行状态、并行调度、失败处理和恢复路径。
- 控制权限和副作用：在工具、文件、网络、服务、人工审批之间建立统一边界。
- 记录 Event、Projection 和 Trace：让一次执行可以被 UI 观察、被审计、被回放，也能被后续 Agent 接续。
- 管理 Artifact：把长输出、测试日志、补丁、审查报告等作为可引用产物，而不是反复塞回模型上下文。

这让模型可以在更清晰的环境里做判断，也让系统不需要把所有责任都压在 prompt 上。

## 多 Agent 协作需要控制协议

多 Agent 的难点不在“启动更多模型会话”，而在协作边界。

如果多个 Agent 只是互相发送自然语言消息，系统很难知道：

- 上游到底交付了什么？
- 下游继承了哪些权限？
- 失败是局部失败，还是整个任务应该阻塞？
- 哪些证据支撑了最终结论？
- 用户或 Runtime 应该在哪里介入？

Open Agent Harness 使用控制协议来组织协作。Agent 之间不直接通信，协作由 Runtime 通过 Assignment、Handoff、Event、Projection 和 Trace 表达。

一个 Agent 完成任务后，可以提交结果、证据、风险和未决问题；Runtime 再把它们整理成 Handoff Contract，交给下一个 Agent 或人工决策者。每一次交接都会重新构造上下文，重新推导权限，并留下可追踪记录。

这套控制协议让多 Agent 协作从“聊天串联”变成“有状态、有边界、有证据的执行流程”。

协议文档位于 `docs/harness-protocol/`，其中 `00-harness-governance-protocol.md` 是总纲，`01-agent-model-and-authoring.md` 定义 Agent 模型，`02-model-runtime-protocol.md` 定义模型与 Runtime 的交互协议。

## License

Open Agent Harness 使用 GNU Affero General Public License v3.0。

本仓库包含来源于 opencode 的代码，原始 opencode MIT 许可文本与版权声明保留在 [LICENSE](./LICENSE)。

Open Agent Harness 与 OpenCode 团队无隶属关系。
