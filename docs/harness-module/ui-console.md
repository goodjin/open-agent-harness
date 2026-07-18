# UI Console Module

## Prompt Shell Detection

The app prompt input supports two shell paths:

- explicit shell mode, entered from the mode control or the leading `!` shortcut,
- automatic shell detection while the prompt remains in normal mode.

Automatic detection is intentionally anchored to the start of the trimmed prompt. A normal-mode prompt is auto-submitted as shell only when the first token is a known shell command, or when the prompt starts with an environment assignment followed by a command-like value.

Text that contains shell snippets later in the sentence stays normal chat. Examples such as `please run npm test && bun typecheck`, `帮我运行 rg foo | head`, or `content includes shell: git status` must not switch the composer into shell execution.

The detection function is shared by the composer affordance and submit path, so UI state and actual routing stay aligned.

## Session Workspace Layout

### Session Task

会话主区域提供 Task tab。Page Feed 即使 Task tab 尚未挂载，也会按当前 session 读取 `GET /session/:sessionID/task`，用于顶部状态与任务页共享数据；session 切换、状态事件和定时刷新都经过同一有界请求通道，旧请求不能覆盖新会话。

任务页按当前任务标题与版本、Task Markdown、执行进度与 action、最终结果、相关 Handoff 的顺序展示。结果只读当前 Revision 的可信来源；运行态显示进度，终态区分 recorded、fallback 和 missing。历史列表在用户点击后才加载，正文又在选中某个版本后单独加载。历史版本只读，不能恢复，也不会默认进入 Page Feed。

多 Run 旧会话的 current API 返回 `legacy_multi_run`。Task tab 显示旧版会话 proposal 卡，只列 Run ID、标题和状态，并提示先整理、确认当前任务；UI 不把该响应当作 Current Task 读取 body 或 actions。确认沿用下一次可执行任务的 canonical create/self assignment 证据链。确认前旧 Runs 只是只读快照，不进入 Revision action 图；即使用户从未打开 Task tab，领域绑定入口也会重新读取 persisted Runs 并拒绝未确认的可执行 package。

Proposal 携带旧 Run 总数、`truncated` 标记和最多 50 条首尾快照。页面在截断时显示提示。单 Run 会在任一执行入口先迁移为 Task v1；是否提前打开 Task tab、或 current 请求与执行并发，不改变最终 Task 的 action 与 run ID 集合。

Task detail 的可见优先级高于 current feed。查看历史版本时，后台 current 刷新失败不会叠加错误卡；退出 detail 后才按 current feed 展示 normal、legacy、missing 或 error 状态。

Task Update 与 Handoff proposal 使用专用卡片展示确认、取消、失败和重试。Handoff 启动后，卡片通过 `target_session_id` 跳转到平级目标会话；来源会话继续保留状态、目标链接和结果查看入口。

### Runs Compatibility API

Runs API 是迁移期兼容接口，继续按可执行任务包提供内部执行记录；新 UI 和新 SDK 的主入口是 Task API。父会话只在 Runtime 接受并开始执行至少一个 `agent`、`tool` 或 runtime action 的 DSL 包时创建 Run；普通对话、补充信息、`input`-only 和 `confirm`-only 包不创建。`confirm` 与可执行 action 同包时，要等确认通过、任务实际开始后才创建。父会话委派子会话时，子会话同步获得对应的委派 Run。

父 protocol Run 的 `summary` 来自 actions fan-in 后的模型综合结果。子会话委派 Run 的 `summary` 来自 canonical `ActionResult.result`，无法生成合法 ActionResult 时才展示 fallback。executor 生成的 action 状态摘要保留在 `execution_summary`；两者分别回答“交付了什么”和“执行过程如何收敛”，UI 不混用。

详情固定按任务内容、运行结果、子任务、文档、执行信息的顺序展示。运行结果和执行信息分区渲染，Markdown summary 不会覆盖 action 局部输出或指标。运行中的 Run 不显示空结果卡片；终态无正文时显示 missing，fallback 则显示来源提示，并说明它不代表验证通过。

Run 标题区和左侧列表同时展示 Runtime 状态徽标与结果徽标。Runtime 徽标使用 `running`、`completed`、`blocked`、`failed`；结果徽标只在非运行态显示 recorded、fallback 或 missing。左侧条目还包含 Run ID、开始与完成时间、已完成 action/总 action 进度和文档数量，方便在不打开详情时判断任务范围与结果可用性。

文档区只列出当前 session、Run 目录中的 requirements、designs、plans、reviews 和 manifest Markdown。服务端校验 session/run/path 片段，拒绝绝对路径、路径穿越、非 Markdown 文件、符号链接和不属于已存在 Run 的目录；读取时还会核对 realpath、文件描述符对应的 inode 及项目边界，避免检查后替换文件。UI 只渲染接口返回的安全内容。

协议 Run 的最终结果使用独立 outcome 记录。相同 message 或相同 summary 的重复写入返回既有记录，便于 replay 幂等；不同 summary 的后续写入报冲突，不覆盖首个结果。历史 `protocol_response` fallback 只参与读取，不写回 outcome。

公开 prompt 与 enqueue 接口会保留普通业务 metadata，但清除 `internal`、`source`、`run_id` 和 `turn` 等 Runtime 保留字段。Run 归属只由 Runtime 写入的内部 metadata 和持久化关联决定，客户端不能借公开 metadata 伪造上一 Run 的结果归属。

Desktop session pages keep global workspace controls in the app titlebar right slot. Status, session tree, terminal, review, file-tree, and side-panel toggle controls should not live in the sticky session title row.

The sticky session title row remains scoped to the active conversation: parent navigation, title editing, context usage, and the session menu.

The session title row also shows compact runtime statistics for the active conversation: model, current status name, token usage, and cost. These values are derived from the active session messages and session status map, not from legacy session tree metadata.

The turn filter row for all, thinking, input, output, and tool calls is part of the sticky title area and must use an opaque background. Timeline content should not be visible through the filter row while scrolling.

The composer area owns the live bottom status line for the active session. It derives a compact label, description, and optional metrics from the synchronized `session.status` map, active session messages, streamed message parts, and user-turn metadata. Running sessions should show a precise state such as request queued, request sent, responding, thinking, running a tool, replying with text, rate limited, waiting on permission, waiting on user input, or waiting on child sessions. When timing data exists, the line also shows elapsed duration. While receiving model output, it shows received UTF-8 bytes from streamed text, reasoning, and completed or errored tool output. While a request has been sent but no assistant output exists yet, it shows sent UTF-8 bytes from the user-visible request parts. This request-size metric intentionally does not represent the final provider payload size, which remains available through session logs and payload inspection. Completed, user-completed, archived, or idle sessions do not show the live line. A latest user turn with `metadata.turn.status === "done"` also suppresses the generic responding line, even if stale assistant parts are still present in the local message cache.

When the active session is busy, normal composer submissions are immediately persisted as follow-up queue entries instead of starting another session loop. The primary composer button depends on content, not only busy state: idle plus content sends, busy plus content persists and queues, busy plus empty input stops the current turn, and idle plus empty input is disabled. Attachments and comments count as content. Persisted queued turns survive refresh and process restart, and each row exposes a cancel control that removes only that queued message. A queued turn remains labeled `请求排队中`; the UI must not infer `请求已发出` solely from the coarse session `running` status.

The composer also exposes a manual continue prompt when the current session is stopped in a recoverable abnormal state: `interrupted`, `aborted`, `paused`, `failed`, `blocked`, `timeout`, or `error`. It must not appear for active statuses that bootstrap can auto-continue, such as `running`, `queued`, `starting`, `rate_limited`, or `retry`. Ordinary Continue actions call session tree resume with `mode=auto`: the server restores an eligible run or persists a user message containing `继续` when no-message restoration is unavailable.

Rate-limited status copy must distinguish concurrency from request frequency. `kind: "concurrency"` means an active provider, model, or agent slot count is full and should show active/limit. `kind: "rpm"` means the rolling request window is full and should be described as request frequency rather than concurrent sessions.

Session turn rendering groups assistant messages by `assistant.parentID === user.id`, not by a simple contiguous user/assistant block. Follow-up user messages, manual continues, retries, or failed tool-call recovery can append assistant messages after later user messages while still belonging to an earlier turn. The timeline and its thinking/output/tool filters must preserve those parent-linked assistant parts so streamed thinking, text output, failed tools, and final error cards remain visible after the session ends.

Assistant text output renders Markdown while the response is still streaming. The renderer parses the accumulated text snapshot and, for display only, temporarily closes an unmatched fenced code block so partial code output stays readable. This does not change the stored part text, copied response text, logs, or final render; once the text part or assistant message is complete, the renderer uses the original Markdown exactly as received.

Malformed protocol output and failed `ActionResult` submissions in the session timeline use compact operator-facing displays. Internal `invalid` tool calls for failed `AgentProtocolOutput` parsing show only the error type `解析输出失败` and the captured model output. Failed `ActionResult` tool calls show only `解析结果失败` and the captured model submission. Detailed metadata, payload ids, byte counts, schema diagnostics, and export controls belong in the Logs panel, not in the main conversation timeline.

Active question, confirmation, and permission prompts render in the timeline active turn panel, not as full composer docks. The panel keeps the prompt header, Markdown body, choices, option descriptions, notes, and action footer in one visual frame. Decision footers stay fixed at the bottom of the panel, while the body is the only scrollable region and carries `data-scrollable` for nested scroll-boundary handling. The composer may show compact status or queue summaries, but it must not host the final confirmation or selection buttons for a timeline prompt.

Timeline frames have explicit height ceilings. Question and protocol confirmation panels may grow to `500dvh`; permission panels to `200dvh`; child-delegation and todo state panels to `300dvh`; text and reasoning output blocks to `1000dvh`; tool, bash, protocol, raw, and error output blocks to `300dvh`; and diff output blocks to `500dvh`. The timeline itself remains the main viewport-sized scroll container; these limits apply to individual frames inside a turn. When the active pending question shares the same tool-call key as a pending protocol confirmation, the duplicate confirmation card stays hidden so there is only one actionable surface.

Protocol confirmation and child-delegation rows use the same turn ownership rule as assistant parts. A persisted record whose `message_id` or `parent_message_id` points at an assistant message belongs to the user turn named by that assistant message's `parentID`, even if local message ordering places the assistant message after a later user message. Contiguous message order is only a fallback for older or incomplete message records.

Assistant part frame titles describe the frame content, not just the latest stream status. Text frames use `assistant text`. Reasoning frames are identified by `part.type === "reasoning"` and use `思考中` while the reasoning part can still stream, then `思考过程` after the reasoning part ends or after the owning assistant message completes. Collapsed reasoning frames keep the same reasoning title instead of deriving a topic-style collapsed title from the hidden content.

When a turn creates delegated child sessions, the timeline renders the child session list from the persisted user-turn metadata first. `metadata.turn.children` is the ordered display record for the child list and stores only child ids plus compact projection fields such as label, run, status, current flag, and result reference. Assigning a child marks it current, child result storage keeps it current until the parent has been notified, parent notification moves it into history, and explicit child continuation marks it current again for that continuation window. Older turns without persisted child metadata may still fall back to the full parent session `dsl_context.protocol.pending_delegations` and `completed_delegations`.

Pending and completed delegation rows share one list, and each row reads the live `session.status` map so running, waiting, interrupted, failed, blocked, user-completed, and completed children update without waiting for a parent reply. If the live map has no entry for a historical child, the row falls back to the persisted delegation projection status, then completed/notified metadata, and only then `idle`. Every child row keeps an Open action so ended sessions remain inspectable. Live children expose Pause; interrupted children expose Restore. Unfinished children may be marked user-completed by explicit user action. Ended children do not show a generic Continue action.

Child runtime status and result delivery status remain separate in the Timeline. A child may stay `blocked` while a transcript-based fallback has already been delivered as `partial`. In that case the row keeps the blocked runtime label and also shows a fallback delivery notice with its bounded summary. Ordinary partial results are not labeled as fallback, and fallback delivery never implies that a verifier gate passed.

Session tree, child, descendant, list queries, and slim `session.updated` events are lightweight projections. They may update the tree store used for navigation and badges, but they must not overwrite the full session detail store used by the active conversation area. Full session data comes from the single-session detail endpoint and is stored separately so large fields such as `dsl_context` stay available for the active session without being duplicated through every tree row. If a slim update arrives after full detail is loaded, the update may merge lightweight fields such as title and timestamps while preserving existing detail-only fields.

Session opening follows a basic-first loading order. The main conversation area loads the full session record and the first message page first, and the right-side panel only loads its expanded tab data after the main timeline is ready and has had a render turn. Timeline and Review diff lists use summary projections containing file path, status, additions, and deletions only. Full `before` / `after` file contents are fetched through the diff detail endpoint only when the user expands a specific diff file.

Opening a session is a read-only UI action. Session detail, message page, tree/descendant, log, and diff-summary requests may refresh projections, but they must not trigger protocol recovery, resume a model loop, or start delegated work. Automatic continuation belongs to runtime bootstrap and explicit resume/restore commands; stale interrupted sessions that bootstrap leaves stopped should be surfaced as recoverable UI state instead of resumed from a read endpoint.

Child session creation events are refresh signals for the parent timeline, not enough data to render a current-turn delegation row by themselves. When the app receives a child `session.created` with `parentID`, it records that parent as stale and keeps the existing session-tree invalidation. The parent list is refreshed only after that parent emits `session.updated`, then the app fetches the full parent session so `dsl_context.protocol.pending_delegations` is available again. This avoids rendering from a bare child row before `SessionDelegation.assign()` has written the parent protocol state.

Failed or blocked delegated children expose a Confirm Result action. It opens a dialog populated from the child's latest assistant text, explains that the model did not submit a native `ActionResult`, and lets the user edit the content before submitting it as a fallback result. Confirmation sends the edited text to the child-session fallback endpoint, refreshes both child and parent sessions, and leaves the child marked as user-completed.

The child session list footer includes two parent-run actions. "Cancel and continue" terminates each pending child session for the run, marks it aborted, records that no child result was requested, clears the parent pending delegation entry, and resumes the parent with an aggregate handoff. "Terminate and summarize" terminates unfinished child sessions for the run, uses any already delivered structured result, otherwise creates a transcript-based interim summary, marks only unfinished children user-completed, clears the parent pending delegation entry, and resumes the parent with the aggregate handoff. If a child is already completed, the UI action preserves that status; Runtime reuses its recorded result when available and only summarizes the transcript when no result can be found. Neither action leaves pending child sessions running independently.

After the user submits a child-session footer action, the list remains fixed in the original timeline turn as a read-only record. Child rows still expose Open, but pause, restore, fallback, mark-complete, and footer submit actions are disabled and the clicked footer action changes to an already-submitted label. If the user tries to terminate and summarize a child list after a later user input has already appeared, the UI first warns that continuing will immediately collect available child results and submit them to the parent before locking the list.

User-completed status markers use a success-toned check indicator instead of the generic status dot. This keeps manual user completion visually distinct from critical/error states while still separating it from natural runtime completion in the text label.

Sidebar parent-session summaries show recursive child progress as completed/total. Lightweight session-tree loads must carry child `status` values into the synchronized `session_status` map, because the sidebar does not load full child messages for every row. Child session creation also invalidates the directory session-tree cache so later reloads can refresh descendant totals instead of relying on stale root-loaded markers.

The sidebar session tree must preserve the user's current scroll position during session navigation. Opening a session, clicking a child row, expanding or collapsing a row, and jumping to a message from the hover preview may update the route, active highlight, notification state, or workspace expansion, but they must not call `scrollIntoView` or otherwise chase the active row. The only sidebar tree scroll changes should come from direct user scrolling, explicit load-more interactions, or restoring the saved scroll position for that workspace.

The session title menu exposes "mark as user completed" for unfinished, interrupted, failed, blocked, paused, waiting, timeout, and aborted sessions. The UI label must distinguish this state from natural runtime completion.

The right-side session panel owns Review, Logs, Graph or Protocol, file tree, context, and file tabs. Its tab strip includes a collapse control that closes the whole right panel through `reviewPanel.close()`, allowing the timeline and composer to reclaim the width. The topbar keeps a side-panel toggle next to the file-tree control, so a collapsed panel still has a visible expand entry. Topbar Review and file-tree controls also reopen the panel before selecting their target tab.

The Graph or Protocol tab badge shows the current session's actual direct child-session count from synchronized session records. It is not derived from the selected workflow or protocol run's action total. Protocol run `completed/total` remains visible inside the graph panel where it describes that graph, not the whole session tree.

## Session Logs

Session status transitions emit `session.status.changed` log records. Each record includes the previous status type, new status type, full previous and new status payloads, and a reason derived from the transition context or status message. The logs panel exposes a Status filter so state-machine changes can be inspected separately from LLM, tool, and protocol activity.

LLM request rows keep the timeline lightweight by showing the provider/model summary, message count, tool count, logged byte count, and a large-payload reference in the list. The expanded detail view still treats logs as inspectable records: when a request log only contains persisted message IDs and summary byte counts, the Messages and User sections expose a full-content action that fetches the corresponding session messages and renders their parts on demand.

The final provider request payload is stored outside the log row under a session-scoped payload id. The Payload section loads it on demand and shows the transformed provider params plus the final active tool list, including native runtime tools such as `ActionResult`. This keeps large system prompts, message arrays, and tool schemas out of the default list render while preserving the exact request evidence needed for request forensics.

The main session area defaults to the conversation Timeline view, which continues to render synchronized `message` and `part` records. It also exposes a Logs mode for wider request forensics in the same main panel. Logs mode reads the same session-local log records and payload details as the side Logs panel, but groups inspection around provider requests, provider responses, and tool calls.

Large request and response payloads are stored as immutable session-local observation manifests. A manifest references semantic chunks rather than duplicating one large JSON payload per request. Chunks are split by readable structure such as system prompt, agent identity or rules, skill text, tool definitions, turns, provider params, response text, tool calls, MCP tool calls, tool results, MCP results, and raw provider events. If the same structure is reused in the same session, later manifests may reference the existing chunk; if the structure changes, a new chunk is written and older manifests keep pointing at the previous chunk.

Tool-call logs use the same `tool` part and `tool.start` / `tool.finish` / `tool.error` lifecycle for built-in tools, custom tools, MCP tools, and protocol tools. The UI classifies them by source: built-in shell execution such as `bash` is shown as CLI/builtin, MCP tool results carry MCP metadata when available, protocol carriers such as `AgentProtocolOutput` and `ActionResult` are protocol tools, and remaining project-registered tools are custom. Logs mode can filter or inspect MCP calls without treating MCP as a separate execution mechanism from ordinary model tool calls.

Compaction and pruning may change message/part content used by the default timeline and future model context, but they must not mutate observation chunks. If an old tool result or large protocol transcript is pruned from message parts, the timeline may show a compacted placeholder while Logs mode can still load the original request, response, or tool result evidence from the observation manifest/chunks.
