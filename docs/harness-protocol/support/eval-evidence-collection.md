# Agent Protocol DSL 评测证据采集设计

## 目标

实验需要能复查、能汇总、能支撑论文 claim。证据采集的重点不是做一个新的用户透明度界面，而是在不破坏 opencode 现有产品交互的前提下，把每次 agent 运行中的可验证证据提取出来。

证据应支持回答：

- 模型调用了几轮？
- 每轮 token、cost、latency 是多少？
- 工具调用或 runtime action 发生了什么？
- 哪些内容回传给模型，哪些完整输出只存为 artifact？
- 最终 diff、测试结果、review finding 是否正确？
- DSL 是否 parse/validate 成功，是否发生 repair？
- XML result envelope 是否真的减少了 replayed observation tokens？

## 当前 opencode 中可复用的数据层

初步检查发现，opencode 已经有适合抽取证据的数据结构。

### Session / Message / Part

相关文件：

```txt
packages/opencode/src/session/session.sql.ts
packages/opencode/src/session/message.ts
packages/opencode/src/session/message-v2.ts
packages/opencode/src/session/index.ts
packages/opencode/src/session/processor.ts
```

已有表：

- `session`
- `message`
- `part`
- `session_log`

已有 part 类型覆盖：

- text
- reasoning
- tool invocation
- step-start
- step-finish
- patch
- file
- snapshot

这些数据可以用于提取：

- message 顺序
- assistant/user message
- tool call 和 tool result
- step start/finish
- snapshot hash
- patch files
- assistant token usage
- assistant cost
- finish reason

### SessionLog

相关文件：

```txt
packages/opencode/src/session/log.ts
packages/opencode/src/session/session.sql.ts
packages/opencode/src/session/processor.ts
```

`SessionLog.emit()` 已经可以写入结构化 session log，并通过 `SessionLog.list()` 查询。

这是最适合做评测证据埋点的位置，因为：

- 它已经按 `sessionID`、`messageID`、`partID` 关联。
- 它是结构化 JSON。
- 它不会改变主 UI 行为。
- 它可以通过脚本导出。

现有 `processor.ts` 已经记录了类似：

- `step.start`
- `step.finish`

这说明不需要新建一套日志系统，只要扩展评测相关事件即可。

### Timeline / Snapshot

相关文件：

```txt
packages/opencode/src/session/timeline.ts
packages/opencode/src/snapshot
```

`SessionTimeline` 能从 `step-start` 中读取 snapshot，并预览 diff。

这适合提取：

- 每个 step 对 workspace 的影响
- changed files
- diff
- restore/checkpoint 信息

## 总体策略

优先顺序：

1. **先用脚本从现有 session/message/part/log 中抽证据。**
2. **再增加低侵入 SessionLog 事件。**
3. **最后才考虑在界面加一个开发者/评测用导出入口。**

不建议一开始改主聊天界面，因为：

- 主界面是用户核心路径，改坏风险高。
- 评测证据多数不需要可视化才能采集。
- 脚本和结构化日志更适合论文复现。

## 证据采集方案

### 方案 A：纯脚本导出，优先推荐

新增一个评测导出脚本，从现有数据库和 artifacts 读取数据。

建议位置：

```txt
packages/opencode/src/session/eval-export.ts
```

或者先放在文档实验区：

```txt
docs/harness-protocol/support/eval/scripts/export-session.ts
```

输入：

```txt
sessionID
taskID
system
runID
outputDir
```

输出：

```txt
eval/runs/<task-id>/<system>/<run-id>/
  session.json
  messages.json
  parts.json
  logs.json
  timeline.json
  metrics.json
  final.md
  diff.patch
  artifacts/
```

可以直接抽取的字段：

- message count
- assistant message count
- tool invocation count
- step count
- token usage
- cost
- finish reason
- message/part timestamps
- patch files
- snapshot diff

优点：

- 不影响 UI。
- 改动最小。
- 适合快速做 pilot。

缺点：

- 如果现有日志没有记录“哪些 observation 回传给模型”，需要额外埋点。
- 如果完整工具输出没有 artifact 化，需要后续补齐。

### 方案 B：增加评测日志事件，推荐作为 v1 必做

在现有 `SessionLog.emit()` 基础上增加评测事件，不改主界面。

建议事件类型：

```txt
eval.run.start
eval.run.end
eval.model.input
eval.model.output
eval.protocol.parse
eval.protocol.validate
eval.protocol.repair
eval.executor.start
eval.executor.end
eval.artifact.store
eval.envelope.create
eval.observation.replay
eval.metric
```

事件数据示例：

```json
{
  "task": "T03",
  "system": "dsl",
  "run": "run-001",
  "action": "test",
  "tokens": {
    "artifact": 10320,
    "replayed": 420
  },
  "artifact": "artifact://T03/dsl/run-001/action-test.stdout",
  "envelope": "artifact://T03/dsl/run-001/action-test.envelope.xml"
}
```

这类日志能补齐论文最需要的证据：

- stored artifact tokens
- replayed observation tokens
- XML envelope size
- DSL parse/validation/repair 次数
- executor latency
- result policy 是否生效

### 方案 C：增加“导出证据”界面入口，可选

如果确实要改界面，建议只做一个低侵入入口，而不是改聊天主流程。

推荐位置：

- session detail 的开发者菜单
- debug/settings 页面
- hidden route，例如 `/eval-export?session=<id>`
- 只在 dev mode 或 feature flag 下显示

按钮：

```txt
Export Eval Evidence
```

点击后导出：

```txt
session evidence zip/json
```

界面只做三件事：

1. 选择当前 session。
2. 填写 `taskID`、`system`、`runID`。
3. 触发导出并显示导出路径。

不要在主聊天界面里加入大量评测 UI。不要改变消息渲染、工具调用、权限确认等现有交互。

## 不建议的改造

不建议：

- 在主消息流里插入大量实验字段。
- 改动 tool result 的用户可见渲染方式。
- 为评测新增复杂 dashboard 到主产品。
- 让 UI 成为唯一证据来源。
- 为了实验改变 agent 实际执行逻辑。

证据采集应该旁路化：

```txt
runtime/session data -> log/export script -> eval artifacts
```

而不是：

```txt
UI rendering -> 人工复制 -> 表格
```

## 需要补的关键证据点

现有 session 数据能覆盖很多内容，但下面这些需要明确补充。

### 1. Model Input Snapshot

需要保存每次模型调用的实际输入，至少保存：

- system prompt hash 或完整内容
- user/developer message
- replayed observations
- tool schema 或 protocol schema
- context token count

否则无法计算 context pollution 和 replayed observation tokens。

### 2. Observation Replay Segment

每段回传给模型的 observation 都要有独立记录：

```json
{
  "id": "obs-003",
  "source": "tool:test",
  "kind": "xml_envelope",
  "tokens": 420,
  "artifact": "artifact://...",
  "text_path": "artifacts/obs-003.xml"
}
```

这是 context pollution 标注的基础。

### 3. Artifact Token Count

完整工具输出和 artifact 需要记录 token 数：

```json
{
  "artifact": "artifact://...",
  "bytes": 48291,
  "tokens": 10320,
  "replayed": false
}
```

这样才能证明“完整输出存在 artifact，但没有回传模型”。

### 4. DSL Parse / Validate Result

DSL 系统必须记录：

```json
{
  "valid": false,
  "errors": [
    {
      "path": "payload.actions.1.depends_on",
      "message": "missing action id"
    }
  ],
  "repair": true
}
```

用于计算：

- valid DSL rate
- repair attempts
- schema failure categories

### 5. Final Diff And Test Result

每个 coding run 至少保存：

- final diff
- changed files
- test command
- test exit code
- test summary
- full test artifact

## 脚本提取指标

`export-session` 或 `build-metrics` 脚本应生成：

```json
{
  "task": "T03",
  "system": "dsl",
  "run": "run-001",
  "model_turns": 3,
  "tool_calls": 4,
  "executor_actions": 4,
  "input_tokens": 9320,
  "output_tokens": 2100,
  "replayed_observation_tokens": 1180,
  "stored_artifact_tokens": 18400,
  "latency": {
    "end_to_end": 74200,
    "model": 39100,
    "executor": 27600,
    "runtime": 7500
  },
  "dsl": {
    "parse_errors": 0,
    "validation_errors": 1,
    "repair_attempts": 1
  }
}
```

## 对 12 个实验的证据映射

| 任务类型 | 需要的关键证据 |
|---|---|
| T01/T02/T10/T12 信息搜集 | search/read observations、引用文件、final answer、context pollution 标注 |
| T03/T06/T09/T11 coding/edit | final diff、test output、patch attempts、test attempts、token/turns |
| T04/T05 test generation | added tests、test command、test pass/fail、是否复制实现逻辑的人工评分 |
| T07/T08 code review | fixture diff、review findings、seeded bug found、false positives、引用准确性 |

## 最小实现建议

第一阶段不要改 UI，只做脚本和日志。

### Step 1：导出现有 session 证据

实现：

```txt
export-session --session <id> --task T03 --system dsl --run run-001 --out eval/runs/T03/dsl/run-001
```

当前已实现一个低侵入脚本入口：

```txt
cd packages/opencode
bun run script/eval-export-session.ts \
  --session <sessionID> \
  --task T03 \
  --system dsl \
  --run run-001 \
  --out ../../eval/runs/T03/dsl/run-001 \
  --cwd /Users/jin/github/opencode
```

导出：

- messages
- parts
- session logs
- timeline
- diff
- basic metrics

当前脚本实际导出：

```txt
session.json
messages.json
logs.json
diff.json
metrics.json
final.md
artifacts.json
artifacts/
```

其中 `metrics.json` 会汇总：

- model turns
- tool calls/results
- input/output/reasoning/cache tokens
- cost
- replayed observation tokens
- stored artifact tokens
- changed files
- model/executor/end-to-end latency
- DSL parse/validation/repair 事件计数

### Step 2：补 SessionLog eval 事件

在模型调用、协议解析、executor 执行、artifact 存储、observation replay 处写 `SessionLog.emit()`。

### Step 3：生成 metrics

实现：

```txt
build-metrics eval/runs/T03/dsl/run-001
```

### Step 4：可选 UI 导出入口

只在 dev/eval flag 下显示：

```txt
Export Eval Evidence
```

不要影响普通用户界面。

## 结论

opencode 当前结构适合通过数据层和日志层收集证据，不需要大规模改造界面。

推荐路线：

```txt
Session/Message/Part/Log/Timeline
        ↓
export-session 脚本
        ↓
eval/runs 标准目录
        ↓
build-metrics 汇总
        ↓
少量人工 judgment/context 标注
```

如果要改界面，只做一个隐藏的证据导出入口。界面不是证据来源本身，证据来源应该是 session 数据、structured logs、artifacts、diff 和 test output。
