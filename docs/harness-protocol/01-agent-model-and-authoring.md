# Agent 模型与编写规范

Agent 模板存放在 `config/agents/<id>/` 下，包含 `meta.json`，并可选包含 `identity.md` 和 `rules.md`。`<id>` 目录名必须与 `meta.json.id` 一致；package 模板和用户模板合并后，所有 id 必须唯一。

本文定义 Harness 的 Agent 编写协议。Agent 是可复用模板，包含入口规则、能力元数据、prompt 材料、模型偏好和权限策略。具体工作需要执行时，Runtime 从模板创建 Agent Session。

Runtime 将 package、user、project 三类模板加载到同一个 registry 中。相同 id 的后加载模板覆盖先加载模板。无效模板产生诊断信息，但不阻止有效模板加载。

Harness 区分三类信息：

- `entry`：Agent 可以从哪里被调用。
- `capability`：Agent 适合做什么。
- `permission`：Agent 在某个具体 assignment 中实际可以做什么。

Agent metadata 是协议对象，不只是 UI 展示信息。Runtime 需要通过 metadata 理解一个 Agent 的身份、能力、入口、权限、依赖、成本、风险和可观测性边界，才能在不同场景下做 routing、delegation、context construction、permission derivation、trace、evaluation 和 recovery。

清晰的 Agent metadata 解决四类问题：

- **管理**：系统知道哪些 Agent 可见、可委托、可作为主 Agent、默认是否可选，以及在什么条件下应被隐藏或禁用。
- **调度**：系统根据 capability、成本、写入倾向、模型偏好、依赖和编排策略选择合适 Agent，而不是依赖自然语言猜测。
- **隔离**：每个 Agent 拥有自己的 session、authority、context、artifact 和 trace，方便独立调优、测试、评估和替换。
- **协作**：Agent 之间的关系通过 Runtime 表达为 Action、Assignment、Handoff Contract 和 Event，而不是两个 session 直接互相发消息。

因此，Agent 定义至少需要覆盖这些 metadata 面：

- identity metadata：`id`、`name`、`description`、`persona`
- kind metadata：`kind`
- entry metadata：`entry`
- capability metadata：`capability.purpose`、`capability.tags`、`capability.cost`、`capability.writes`
- permission metadata：`permission_mode`、`allowed_tools`、`denied_tools`、`inherit_permissions`
- runtime metadata：`model_preference`、`execution_mode`
- relationship metadata：`relationships`
- orchestration metadata：`orchestration_policy`

`relationships` 描述 Agent 与其他 Agent 或 capability 的稳定关系。它帮助 Agent Manager、catalog、routing prompt 和评估系统理解 Agent 的协作结构。真正触发执行时，Runtime 仍应通过 `orchestration_policy` 或显式 Action 创建 Assignment。

## Agent 模板与 Agent Session

Agent 模板本身不执行 assignment。Runtime 从 Agent 模板创建 Agent Session，将 assignment authority 绑定到该 session，并把 session 记录为 run trace 的一部分。

一个 Agent Session 包含：

- 稳定的 session id
- 来源 Agent 模板 id
- assignment 或 root run 关系
- session log
- 生效 authority
- trace refs
- status

Session log 是与该 session 相关的已接受消息、协议输出、Action、Observation、Artifact refs 和状态变更的持久记录。

Model context 与 session log 不是同一个对象。每次模型调用前，Runtime 根据 session log、当前 Projection、相关 Memory、Artifact refs、环境信息、约束和语义解释提示构造 Context Bundle。

## 必填字段

- `id`：稳定模板 id。使用与目录名相同的值。会裁剪空白字符，空值会被拒绝。
- `name`：展示名称。会裁剪空白字符，空值会被拒绝。
- `persona`：用于 prompt 构造的简短行为契约。会裁剪空白字符，空值会被拒绝。
- `description`：面向用户的摘要。会裁剪空白字符，空值会被拒绝。

## 命名规范

Agent id 使用直观的 `lower_snake_case`，形态为 `<domain>_<work_type>`。

`domain` 表示 Agent 面向的工作领域，例如 `frontend`、`backend`、`database`、`security`、`workflow`、`release`、`session`。`work_type` 表示 Agent 在该领域处理的工作类型，例如 `developer`、`test`、`reviewer`、`planner`、`runner`、`maintainer`、`researcher`、`debugger`、`summarizer`。`work_type` 是命名后缀，用于提高可读性；Runtime routing 仍根据 `capability`、`entry`、authority、availability 和 budget 选择 Agent。

命名示例：

- 开发实现：`frontend_developer`、`backend_developer`、`database_developer`、`code_developer`
- 测试验证：`code_test`、`release_test`
- 审查评估：`security_reviewer`、`api_contract_reviewer`、`performance_reviewer`
- 规划编排：`task_planner`、`plan_executor`、`workflow_runner`
- 研究检索：`code_researcher`、`external_researcher`
- 系统任务：`session_compactor`、`session_summarizer`、`session_title_writer`

展示名称 `name` 可以使用自然语言标题，例如 `Frontend Developer`。`capability.purpose` 继续作为 routing hint，不承担命名职责。

## 可选字段与默认值

- `model_preference`：`{ "providerID": "...", "modelID": "..." }`。当 provider/model catalog 可用时，两个 id 都必须存在。
- `hidden`：默认 `false`。
- `execution_mode`：默认 `auto`。
- `allowed_tools`：默认 `[]`。
- `denied_tools`：默认 `[]`。
- `inherit_permissions`：默认 `false`。Agent 默认使用自身 permission profile；只有显式设为 `true` 时才继承或合并外部权限策略。
- `permission_mode`：默认 `strict`。
- `kind`：默认不存在。用于描述 Agent 在协作图中的粗粒度职责形态，不能替代 `capability`、`entry`、`runner` 或权限策略。
- `relationships`：默认不存在。用于声明该 Agent 与其他 Agent 或 capability 的稳定协作关系，例如上游依赖、推荐下游、互斥关系或替代候选。
- `orchestration_policy`：默认不存在。用于声明 Runtime 可以围绕该 Agent Session 评估和创建的前置、后置、恢复、审查、仲裁等后续 Action / Assignment。

## Kind 模型

`kind` 描述 Agent 在接力链里的粗粒度职责。它回答“这个 Agent 完成后，Runtime 通常要不要接另一个 Agent”，而 `capability` 回答“它具体会做什么”。

分类不应过细。`default`、`milestone_planner`、`feature_planner` 都可能同时做 planning、coordination 和 task routing，但它们在接力链里都属于 `planner`：产出计划、拆分任务、决定后续交给谁。`release_runner`、`devops_agent`、`database_agent` 可能操作环境或系统，但只要它们承担主执行产物，就属于 `worker`；权限和风险由 `capability`、`runtime_boundary`、permission 和 gate 表达。

推荐取值：

| kind | 含义 | 适合创建的 Agent |
|---|---|---|
| `planner` | 把目标拆成计划、任务、依赖、验收条件或执行图，可能也负责分派和协调。 | `default`、`feature_planner`、`milestone_planner`、`workflow_runner` |
| `worker` | 执行主任务并产出主要结果，可能修改代码、文档、数据、配置或外部系统。 | `frontend_developer`、`backend_developer`、`database_agent`、`release_runner`、`devops_agent` |
| `verifier` | 对计划或执行结果做验证、审查、测试、复现、风险检查或证据确认。 | `verifier`、`technical_reviewer`、`security_reviewer`、`performance_reviewer`、`ux_reviewer` |
| `helper` | 提供轻量辅助产物或上下文处理，不承担主流程责任，也不决定主接力链。 | `summary`、`title`、`compaction`、`librarian`、`agent_creator` |

典型接力规则：

- `planner` 完成后，Runtime 通常选择一个或多个 `worker` 执行计划；高风险计划可以先接 `verifier` 做计划审查。
- `worker` 完成后，如果产生写入、发布、迁移、外部操作或关键 Artifact，Runtime 通常接 `verifier`。
- `verifier` 完成后，Runtime 根据结果决定结束、退回 `worker` 修复、退回 `planner` 重新拆分，或请求用户决策。
- `helper` 通常作为旁路能力被调用，例如补上下文、摘要、标题、检索材料，不默认触发后续接力。

`kind` 的使用边界：

- Runtime 可以用 `kind` 做默认接力策略、routing 解释、catalog 分组和评估维度。
- Runtime 不应只根据 `kind` 选择 Agent。实际路由仍结合 `capability`、`entry`、authority、availability、budget、contracts 和 current Projection。
- `kind` 不授予权限。执行外部操作的 `worker` 仍要经过 permission profile、assignment authority 和 gate。
- 一个 Agent 只能声明一个主 `kind`。如果它覆盖多个职责，应把具体能力放进 `capability.tags`，或拆成多个 Agent 模板。

## Entry 模型

`entry` 是 Agent 可被使用位置的事实来源。它刻意与权限和调度质量分离。

```json
{
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": true,
    "hidden": false
  }
}
```

字段含义：

- `primary`：可以作为主会话 Agent 运行，并出现在主 Agent 切换器中。
- `delegable`：可以被任务/委托机制启动。
- `mentionable`：可以通过用户 mention 或自动补全直接调用。
- `default`：可以被默认 Agent 解析逻辑选中。
- `hidden`：即使其他 entry flag 为 true，也不应出现在常规用户选择器中。

选择规则：

- 主 Agent 切换器：`entry.primary && !entry.hidden`
- mention 自动补全：`entry.mentionable && !entry.hidden`
- delegation 候选：`entry.delegable && !entry.hidden`
- 默认 Agent 资格：`entry.primary && entry.default && !entry.hidden`

## Capability 模型

`capability` 描述 Agent 擅长什么。Dispatcher 和 prompt builder 应结合这些元数据与 `description` 判断何时委托。

```json
{
  "capability": {
    "purpose": "architecture_review",
    "tags": ["architecture", "debugging", "review"],
    "cost": "high",
    "writes": false
  }
}
```

字段含义：

- `purpose`：简短稳定的 routing hint。
- `tags`：用于 prompt 生成和 dispatch table 的可搜索能力标签。
- `cost`：相对执行成本，取值为 `low`、`medium` 或 `high`。
- `writes`：声明式元数据，表示该 Agent 是否预期会修改 workspace 状态。

`capability.writes` 是元数据，不是权限 enforcement。实际写入权限仍来自 permission policy。

## Execution Mode

`AgentTemplate.execution(meta)` 根据所选模式返回 runtime behavior object：

- `auto`：`{ "autonomous": true, "prompt": false, "review_tools": false, "review_state": false }`。运行常规自主 prompt loop。
- `manual`：`{ "autonomous": false, "prompt": true, "review_tools": true, "review_state": true }`。在执行实质操作前等待明确用户指令。
- `supervision`：`{ "autonomous": true, "prompt": false, "review_tools": true, "review_state": true }`。可以自由计划和检查，但工具使用和状态变更工作需要升级审查。

## Permission 模式

`AgentTemplate.permission(meta)` 根据所选模式返回可消费的 permission profile。

Agent 默认不继承项目或上层会话权限。每个 Agent 应拥有自己的权限 profile，Runtime 再根据 assignment authority、run policy、用户审批和 gate requirement 推导最终可执行边界。

- `strict`：使用 Runtime 定义的 Agent strict profile，并应用 `denied_tools`。当 `inherit_permissions` 为 true 时，可以与项目或上层默认策略合并，但拒绝项优先。
- `lax`：使用 Runtime 定义的 Agent lax profile，并应用 `denied_tools`。当 `inherit_permissions` 为 true 时，可以与项目或上层允许策略合并，但拒绝项优先。
- `custom`：使用 `allowed_tools` 和 `denied_tools` 作为作者定义的 Agent permission profile。只有当 `inherit_permissions` 为 true 时，才与外部权限策略合并。

## Relationship Metadata

`relationships` 描述 Agent 的协作关系。它让系统知道某个 Agent 经常依赖哪些上游 Agent、常把结果交给哪些下游 Agent、与哪些 Agent 不应并行运行，以及当目标 Agent 不可用时可以考虑哪些替代能力。

Relationship metadata 结构：

```json
{
  "relationships": {
    "upstream": [
      {
        "id": "amazon_product_analysis",
        "target": {
          "executor": "agent",
          "capability": "amazon_product_analysis"
        },
        "required": true,
        "order": "sequential",
        "reason": "Cross-border market research needs a product analysis artifact before market synthesis.",
        "artifacts": ["product_analysis_report"]
      }
    ],
    "downstream": [
      {
        "id": "market_research_synthesis",
        "target": {
          "executor": "agent",
          "capability": "market_research"
        },
        "reason": "Use product analysis as input for broader market research."
      }
    ],
    "alternatives": [
      {
        "target": {
          "executor": "agent",
          "capability": "product_research"
        },
        "reason": "Fallback when the Amazon-specific agent is unavailable."
      }
    ],
    "conflicts": [
      {
        "target": {
          "executor": "agent",
          "capability": "destructive_data_migration"
        },
        "reason": "Do not run market research in the same assignment chain as destructive migration."
      }
    ]
  }
}
```

字段含义：

- `upstream`：当前 Agent 执行前通常需要的输入来源。适合声明可复用的前置 Agent，例如跨境调研 Agent 依赖亚马逊商品分析 Agent。
- `downstream`：当前 Agent 产物常交给的后续 Agent。它帮助 UI、catalog 和 Runtime 建议下一步，但不直接授予调用权。
- `alternatives`：目标 Agent 缺失、禁用、成本过高或不可用时可考虑的替代能力。
- `conflicts`：不应在同一 assignment chain 中自动组合的 Agent 或 capability。
- `target`：可以指向具体 Agent id，也可以指向 capability，由 Runtime routing 决定最终 executor。
- `required`：关系是否构成当前 Agent 默认执行质量的一部分。
- `order`：关系展开时建议使用 `sequential` 或 `parallel`。
- `reason`：给 Agent Manager、routing prompt、trace 和评估报告使用的短说明。
- `artifacts`：该关系通常产生或消费的 Artifact 类型。

`relationships` 不等于执行权限。Runtime 可以用它生成候选、解释协作图、辅助评估和补全 `orchestration_policy`，但只有被 Runtime 展开成 Action / Assignment 后才会执行。

如果某个上游关系需要每次执行都自动触发，应在 `orchestration_policy.preflight` 中声明对应编排项。这样元数据负责描述稳定关系，编排策略负责定义触发条件、contract、预算、失败处理和 trace。

## Orchestration Policy

Agent 模板可以声明默认 `orchestration_policy`，用于告诉 Runtime：围绕该 Agent Session 的执行过程，哪些状态、风险、结果或 Artifact 变化可以触发额外的 Runtime 编排。

`orchestration_policy` 表达 Runtime 编排策略。Agent Session 仍然只执行自己的 assignment；Runtime 根据策略创建前置准备、完成后验证、失败恢复、风险审查、Artifact 变更响应、冲突仲裁等受治理的 Action / Assignment。

Orchestration policy 结构：

```json
{
  "orchestration_policy": {
    "preflight": [
      {
        "id": "clarify_requirements",
        "target": {
          "executor": "agent",
          "capability": "requirements_clarification"
        },
        "required": true,
        "order": "sequential",
        "when": {
          "uncertainty": "high",
          "missing": ["acceptance_criteria"]
        },
        "contract": {
          "goal": "Clarify the implementation goal and acceptance criteria before development.",
          "constraints": ["ask_only_decision_relevant_questions"],
          "depends_on": ["input:user.goal"],
          "evidence": [],
          "artifacts": ["requirements_note"],
          "budget": {
            "cost": "low",
            "timeout_ms": 300000
          },
          "risks": ["ambiguous_scope"],
          "unresolved": []
        }
      }
    ],
    "on_completed": [
      {
        "id": "verify_implementation",
        "target": {
          "executor": "agent",
          "capability": "verification"
        },
        "required": true,
        "order": "sequential",
        "when": {
          "result_status": "completed",
          "requires_artifacts": ["artifact://current/patch"],
          "side_effects": ["write"]
        },
        "contract": {
          "goal": "Verify the implementation result.",
          "constraints": ["use_changed_files", "run_relevant_checks"],
          "depends_on": ["artifact://current/patch"],
          "evidence": [],
          "artifacts": ["test_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["implementation_regression"],
          "unresolved": []
        }
      },
      {
        "id": "review_implementation",
        "target": {
          "executor": "agent",
          "capability": "technical_review"
        },
        "required": true,
        "order": "sequential",
        "depends_on": ["verify_implementation"],
        "contract": {
          "goal": "Review the implementation and verification result.",
          "constraints": ["read_only", "focus_on_correctness_and_regression"],
          "depends_on": ["artifact://current/patch", "artifact://test_report"],
          "evidence": ["artifact://test_report"],
          "artifacts": ["review_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["missed_runtime_regression"],
          "unresolved": []
        }
      }
    ],
    "on_failed": [
      {
        "id": "debug_failure",
        "target": {
          "executor": "agent",
          "capability": "debugging"
        },
        "required": true,
        "order": "sequential",
        "when": {
          "result_status": "failed",
          "retryable": true
        },
        "contract": {
          "goal": "Diagnose the failure and recommend a bounded recovery action.",
          "constraints": ["preserve_evidence", "do_not_mutate_without_assignment"],
          "depends_on": ["artifact://failure/logs"],
          "evidence": ["artifact://failure/logs"],
          "artifacts": ["debug_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["incorrect_recovery"],
          "unresolved": []
        }
      }
    ],
    "on_risk_detected": [
      {
        "id": "security_review",
        "target": {
          "executor": "agent",
          "capability": "security_review"
        },
        "required": true,
        "order": "parallel",
        "when": {
          "resources": ["auth", "permission", "secret", "sandbox"],
          "side_effects": ["write"]
        },
        "contract": {
          "goal": "Review security and permission risk introduced by the change.",
          "constraints": ["read_only", "focus_on_security_regression"],
          "depends_on": ["artifact://current/patch"],
          "evidence": ["artifact://current/patch"],
          "artifacts": ["security_review_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["security_regression"],
          "unresolved": []
        }
      }
    ],
    "limits": {
      "max_depth": 3,
      "max_parallel": 4,
      "dedupe_key": "implementation_verification_chain"
    }
  }
}
```

字段含义：

- `preflight`：当前 Agent 执行前可触发的准备性 Assignment，例如需求澄清、上下文研究、外部资料检索。
- `on_completed`：当当前 Agent Session 对应 assignment 成功完成后，Runtime 可以评估的编排项。
- `on_failed`：当前 assignment 失败后可触发的诊断、恢复或重试准备。
- `on_blocked`：当前 assignment 阻塞后可触发的澄清、审批或决策。
- `on_risk_detected`：Runtime 根据资源范围、side effect、权限、文件类型或 gate 识别风险后可触发的审查。
- `on_artifact_changed`：关键 Artifact 发生变化后可触发的验证、摘要、审查或索引更新。
- `on_conflict`：多个 Agent 结果冲突、gate 结果冲突或风险判断冲突后可触发的仲裁。
- `id`：编排项在当前 policy 内的稳定 id，用于 trace、dedupe 和 dependency。
- `target`：后续 executor 目标。可以指定具体 Agent，也可以指定 capability，由 Runtime routing 选择。
- `required`：该编排项是否构成 parent action 完成的必要条件。
- `order`：编排项之间的执行关系，例如 `sequential` 或 `parallel`。
- `when`：触发条件。Runtime 根据 assignment result、artifact、side effects、status 和 gate 评估。
- `depends_on`：同一 policy 内必须先完成的编排项。
- `contract`：后续 Assignment 的 Handoff Contract，包含目标、约束、依赖、证据、Artifact、预算、风险和未决问题。
- `limits`：防止自动编排过深、并发过大、重复触发或形成隐式循环的控制项。

Runtime 可以基于 `orchestration_policy` 主动创建 Assignment，但每个 Assignment 都拥有独立 authority。后续 Agent 不继承来源 Agent 的权限。

常见模式：

- 需求不清晰时，Runtime 先触发 `requirements_clarifier`。
- `cross_border_researcher` 执行前，Runtime 先触发 `amazon_product_analysis` 生成商品分析 Artifact，再把该 Artifact 作为调研输入。
- `code_developer` 完成写入后，Runtime 触发 `code_test`，再触发 `technical_reviewer`。
- `frontend_developer` 完成 UI 修改后，Runtime 触发 `accessibility_reviewer` 和 `ux_reviewer`。
- 测试失败后，Runtime 触发 `code_debugger`。
- 涉及 auth、permission 或 secret 变更时，Runtime 触发 `security_reviewer`。
- `release_runner` 完成 release preparation 后，Runtime 触发 `release_test` 或 release gate。

## 最小模板

```json
{
  "id": "code_developer",
  "name": "Code Developer",
  "persona": "Write and verify focused code changes.",
  "description": "A coding agent for implementation tasks."
}
```

## 完整模板

```json
{
  "id": "code_developer",
  "name": "Code Developer",
  "persona": "Write focused code changes and preserve existing behavior.",
  "description": "A development agent for implementation tasks.",
  "kind": "worker",
  "entry": {
    "primary": true,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "implementation",
    "tags": ["implementation", "debugging", "verification"],
    "cost": "medium",
    "writes": true
  },
  "model_preference": {
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4-20250514"
  },
  "execution_mode": "supervision",
  "allowed_tools": ["read", "grep", "bash", "edit"],
  "denied_tools": [],
  "inherit_permissions": false,
  "permission_mode": "custom",
  "relationships": {
    "upstream": [
      {
        "id": "requirements_context",
        "target": {
          "executor": "agent",
          "capability": "requirements_clarification"
        },
        "required": false,
        "order": "sequential",
        "reason": "Implementation quality improves when unclear requirements are resolved before writing.",
        "artifacts": ["requirements_note"]
      }
    ],
    "downstream": [
      {
        "id": "implementation_verification",
        "target": {
          "executor": "agent",
          "capability": "verification"
        },
        "reason": "Written changes should be verified before review."
      }
    ]
  },
  "orchestration_policy": {
    "on_completed": [
      {
        "id": "verify_implementation",
        "target": {
          "executor": "agent",
          "capability": "verification"
        },
        "required": true,
        "order": "sequential",
        "contract": {
          "goal": "Verify the implementation result.",
          "constraints": ["use_changed_files", "run_relevant_checks"],
          "depends_on": ["artifact://current/patch"],
          "evidence": [],
          "artifacts": ["test_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["implementation_regression"],
          "unresolved": []
        }
      },
      {
        "id": "review_implementation",
        "target": {
          "executor": "agent",
          "capability": "technical_review"
        },
        "required": true,
        "order": "sequential",
        "depends_on": ["verify_implementation"],
        "contract": {
          "goal": "Review the implementation and verification result.",
          "constraints": ["read_only", "focus_on_correctness_and_regression"],
          "depends_on": ["artifact://current/patch", "artifact://test_report"],
          "evidence": ["artifact://test_report"],
          "artifacts": ["review_report"],
          "budget": {
            "cost": "medium",
            "timeout_ms": 600000
          },
          "risks": ["missed_runtime_regression"],
          "unresolved": []
        }
      }
    ],
    "limits": {
      "max_depth": 3,
      "dedupe_key": "implementation_verification_chain"
    }
  }
}
```

## 历史兼容：外部 Markdown instruction 导入

Open Agent Harness 的核心对象是 Agent Template、Workflow、Capability、Contract、Runtime Boundary、Handoff 和 Assignment。`SKILL.md` 不是 Harness 的核心概念，也不作为运行时的一等协议对象。

本节只定义历史兼容和外部生态导入适配：当外部系统、旧插件或历史配置仍提供 `SKILL.md` 这类 Markdown instruction package 时，Runtime 可以把它归一化为只读 Agent record。导入完成后，Harness 协议中的可调用对象仍是 Agent，执行实例仍是 Agent Session。

`SKILL.md` 通常用于描述一类工作应该怎么做：适用场景、执行步骤、判断规则、输入要求、输出格式、质量检查和注意事项。Agent Template 表达可治理的执行模板，除了 prompt 材料，还包含 `kind`、入口规则、能力元数据、权限策略、模型偏好、contracts、completion 和 runtime boundary。

导入层的作用，是把轻量 instruction package 归一化到 Agent registry 中，让它进入统一的 routing、delegation、permission、session creation、trace 和 UI 管理路径。

导入后的虚拟 Agent record 需要具备：

- 稳定 id
- name
- description
- prompt material
- entry flags
- capability tags
- permission profile
- source reference
- source format metadata

Runtime 后续只处理 Agent record。`SKILL.md` 是外部来源文件，导入后的只读 Agent record 是协议对象，Agent Session 是运行实例。

### 支持输入

Runtime 扫描受支持 roots 中名为以下形式的文件：

```text
*/SKILL.md
```

全局 root、项目 root 和插件 root 由 Runtime 配置决定。Agent 目录 root 下也可以支持同级 `skill/` 和 `skills/` 目录，但这只用于兼容导入，不表示 Harness 内部继续以 Skill 作为建模单位。

### 导入规则

每个 `SKILL.md` 都按 Markdown 解析，并允许可选 frontmatter。

导入后的 Agent id 来自：

1. frontmatter 中的 `name`，如果存在。
2. 当 `name` 不存在时，使用来源目录名。

id 会按 Agent 命名规范归一化为 `lower_snake_case`，只包含小写字母、数字和下划线。

导入后的 Agent description 来自：

1. frontmatter 中的 `description`，如果存在。
2. 生成的默认 description。

导入后的 prompt material 从 Markdown body 构造：

- identity、persona、职责说明等章节导入为 Agent `persona`。
- 步骤、规则、检查项、输出格式等章节导入为 Agent rules。
- 其他正文作为补充 prompt material 保留。

生成的 Agent metadata 使用：

```json
{
  "entry": {
    "primary": false,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "imported_instruction",
    "tags": ["imported", "<agent-id>"],
    "cost": "medium",
    "writes": true
  },
  "inherit_permissions": false,
  "permission_mode": "lax",
  "source": {
    "format": "markdown_instruction",
    "path": "<source-dir>/SKILL.md"
  }
}
```

生成的 `meta.json`、`identity.md` 或 `rules.md` 只存在于导入结果。磁盘事实来源保持为原始 `SKILL.md` 文件。

### 优先级

显式 Agent 模板会覆盖相同 id 的导入结果。

这允许历史 `SKILL.md` 或外部 instruction package 逐步升级为完整 Agent Template，并保持 invocation id 不变。

### Runtime 行为

由 `SKILL.md` 导入的对象在 `/agent` 中表现为只读 Agent record，包含：

- `name`：导入后的 Agent id
- `entry`：`{ "primary": false, "delegable": true, "mentionable": true, "default": false, "hidden": false }`
- `capability.purpose`：`imported_instruction`
- `capability.tags`：`["imported", id]`
- `source.format`：`markdown_instruction`

当 Agent metadata 或配置没有隐藏该记录时，它们会出现在 session Agent 选择中。

它们默认可 mention、可 delegation，因为生成的 entry metadata 将其定位为可委托 Agent。

当 Runtime 选择该 Agent 执行工作时，运行链路与普通 Agent 一致：

```txt
Action
  -> routing selects Agent
  -> Runtime creates Agent Session
  -> Runtime builds Context Bundle from assignment and imported prompt material
  -> model produces protocol output
  -> Runtime records Event, Artifact, Projection and Trace
```

Agent Session 的 session log 持久记录该 session 中被 Runtime 接受和引用的消息、协议输出、Action、observation、Artifact ref 和状态变化。

Context Bundle 由 Runtime 在每次模型调用前构造，包含 assignment contract、导入的 prompt material、相关 Projection、Artifact、约束、环境信息和必要的语义解释。

### Agent 管理 UI

管理 API 按 Agent record 返回导入结果，并明确标记为外部导入、不可编辑：

```json
{
  "kind": "agent",
  "editable": false,
  "source": {
    "format": "markdown_instruction"
  }
}
```

设置 UI 可以按来源过滤：

- 全部 Agent
- 手写 Agent
- 外部 Markdown instruction 导入的 Agent

由 `SKILL.md` 导入的 Agent 在 Agent Manager 中以只读记录展示，因为它们的事实来源是原始 Markdown 文件。要定制某个导入结果，可以编辑来源文件，或创建一个相同 id 的手写 Agent Template。

### 升级边界

导入层会保留主要 prompt 内容、description 和可识别的结构化章节，并生成基础 metadata。

需要精细治理时，应使用手写 Agent 模板表达更完整的字段，例如：

- 明确的 `entry`
- 细分的 `capability.purpose`
- 更准确的 `capability.tags`
- `model_preference`
- `allowed_tools` / `denied_tools`
- `permission_mode`
- `orchestration_policy`

`SKILL.md` 只作为历史兼容或外部导入格式保留。新能力应优先写成 Agent Template；需要组织多个 Agent 时写成 Workflow；具体能力差异放在 `capability`、contracts、completion、runtime boundary 和 collaboration metadata 中。

## 内置 Agent Kind 建议

下表基于当前 `packages/opencode/config/agents/*/meta.json` 的实际内置 Agent。这里的 `kind` 是建议归类，用于接力策略和后续迁移；当前文档更新不等于这些 `meta.json` 已经写入 `kind` 字段。

verifier 命名上区分两种用法，影响 Runtime 推断 verifier 依赖 worker 的方式：

- 形如 `<name>-verifier`（例如 `backend-verifier`、`frontend-verifier`）的 verifier 走"同 base name worker 自动绑定"，Runtime 会把 verifier 的 `depends_on` 自动接到对应 worker 上。
- 不带 `-verifier` 后缀的 reviewer（如 `security-reviewer`、`plan-reviewer`、`ux-reviewer`）不绑定单一 worker，调用方必须显式声明 `depends_on` 或写成 `["none"]`。

具体行为由 Runtime 在归一化阶段执行，详见 `02-model-runtime-protocol.md` 的 Verifier 自动依赖推断小节和 `03-action-executor-contract.md` 的依赖归一化与 Verifier 推断小节。

| Agent | 建议 kind | 依据 |
|---|---|---|
| `default` | `planner` | 默认入口，负责意图澄清、规模判断、DSL 任务拆解、路由和结果综合。 |
| `epic-planner` | `planner` | 把 epic slice 拆成 feature，产出边界、依赖、验收信号和可调度 child calls。 |
| `feature-planner` | `planner` | 把 feature 拆成 implementation、verification、review、docs、release 等具体任务。 |
| `milestone-planner` | `planner` | 把 milestone 拆成 epic slices，给后续执行链提供任务图。 |
| `plan` | `planner` | 只读规划、分析、设计、审查和 implementation plan。 |
| `prometheus` | `planner` | 通过访谈、研究和整理创建可执行计划。 |
| `protocol-runner` | `planner` | 以 Agent Protocol DSL 声明结构化执行和路由。 |
| `requirements-clarifier` | `planner` | 在 planning 或 implementation 前澄清意图、隐藏需求、歧义和风险。 |
| `workflow-runner` | `planner` | 管理 Workflow 资产并把 workflow materialize 为 Action Graph。 |
| `agent-creator` | `worker` | 根据自然语言创建 project/user Agent 模板，产出可保存的 Agent artifact。 |
| `atlas` | `worker` | 执行多步计划并协调完成与验证，主职责是推进交付。 |
| `backend` | `worker` | 后端实现、API、数据模型、auth、permission 和 integration。 |
| `build` | `worker` | 主开发 Agent，用于代码修改和验证。 |
| `data-migration-runner` | `worker` | 数据迁移、schema transition、backfill、一致性检查和 rollback-aware plan。 |
| `database-agent` | `worker` | 数据库 schema、migration、query、index、transaction 和数据一致性工作。 |
| `dependency-maintainer` | `worker` | 依赖升级、lockfile、兼容性、breaking changes 和依赖安全修复。 |
| `devops-agent` | `worker` | CI/CD、build scripts、deployment config、本地服务和环境配置。 |
| `docs-maintainer` | `worker` | 维护工程文档，使其反映当前代码和 workflow。 |
| `frontend` | `worker` | 前端实现、UI 行为、样式、可访问性和浏览器验证。 |
| `general` | `worker` | 广泛研究、复杂代码库问题和并行 work unit；当它拥有主任务结果时按 worker 接力。 |
| `hephaestus` | `worker` | 深度端到端实现，主职责是完整交付。 |
| `incident-responder` | `worker` | 事故响应、outage triage、mitigation、verification 和 follow-up。 |
| `migration-runner` | `worker` | 跨文件迁移、rename、API migration 和 architecture migration。 |
| `observability-agent` | `worker` | logging、metrics、tracing、audit、health 和 diagnostics 的实现或修复。 |
| `refactorer` | `worker` | 低风险、保持行为不变的重构。 |
| `release-runner` | `worker` | release preparation、versioning、changelog、artifact、dry run、publish 和 post-release verification。 |
| `sisyphus` | `worker` | 主 orchestrator，但对外承担完整交付，接力策略上更像 worker。 |
| `sisyphus-junior` | `worker` | 聚焦 delegated implementation task。 |
| `workflow-creator` | `worker` | 创建和更新持久化 workflow。 |
| `accessibility-reviewer` | `verifier` | UI 语义、键盘访问、label、focus、contrast 和 assistive technology 审查。 |
| `api-contract-reviewer` | `verifier` | API contract、schema、兼容性、SDK 影响、错误语义和边界审查。 |
| `debugger` | `verifier` | 复现失败、缩小范围、定位根因和建议恢复步骤，通常接在失败 worker 后。 |
| `performance-reviewer` | `verifier` | frontend、backend、runtime、database 和 build workflow 的性能审查。 |
| `plan-reviewer` | `verifier` | 审查计划是否可执行、引用是否有效、阻塞是否真实。 |
| `security-reviewer` | `verifier` | security、permission、sandbox、secret 和 data-access 审查。 |
| `technical-reviewer` | `verifier` | 架构、复杂 debugging、tradeoff 和 post-implementation technical review。 |
| `ux-reviewer` | `verifier` | UX flow、information architecture、interaction clarity、empty states 和摩擦审查。 |
| `verifier` | `verifier` | 运行 validation commands、解释失败并建议下一步。 |
| `compaction` | `helper` | 长会话 continuation summary，不拥有主流程责任。 |
| `explore` | `helper` | 查文件、追代码路径、找模式，主要给 planner 或 worker 补上下文。 |
| `librarian` | `helper` | 官方文档、远程仓库、外部库和实现示例研究。 |
| `multimodal-looker` | `helper` | 分析 PDF、图片、diagram、chart 和视觉文档，为主流程补材料。 |
| `summary` | `helper` | 隐藏系统 Agent，用于 session summaries。 |
| `title` | `helper` | 根据首个用户 prompt 生成短 session title。 |

边界判断：

- `explore`、`librarian`、`multimodal-looker` 是 helper，不是 planner。它们提供材料，不负责把材料收敛成执行图。
- `default`、`milestone-planner`、`feature-planner` 可以同时做协调和路由，但仍归 `planner`，不需要单独 `coordinator`。
- `release-runner`、`devops-agent`、`database-agent` 可能操作外部或高风险资源，但仍归 `worker`；风险差异由 `capability`、`runtime_boundary`、permission 和 gate 表达。
- `technical-reviewer`、`security-reviewer`、`ux-reviewer`、`plan-reviewer` 都归 `verifier`。它们的差异在 `capability.purpose`，不需要单独 `reviewer`。

## 内置 Agent 缺口

按四类看，当前系统不是缺大类，而是缺一些具体 capability：

| kind | 当前覆盖 | 主要缺口 |
|---|---|---|
| `planner` | 已覆盖默认路由、需求澄清、feature/epic/milestone 拆分、workflow materialization 和计划生成。 | 缺少讨论收敛类 planner，例如 `brainstorm_facilitator` 或 `decision_synthesizer`，把多人/多 Agent 讨论收束成选项、取舍、结论和后续任务。 |
| `worker` | 已覆盖前端、后端、数据库、依赖、DevOps、文档、迁移、发布、事故响应、重构、深度实现和 agent/workflow authoring。 | 缺少浏览器自动化执行类 worker、数据分析/报表类 worker、Cloudflare/云资源专门 worker，以及把设计稿或视觉输入落成前端改动的 UI implementation worker。 |
| `verifier` | 已覆盖通用验证、计划审查、技术审查、安全、性能、UX、可访问性和 API contract。 | 缺少 artifact contract verifier、release readiness verifier、data migration consistency verifier、browser E2E verifier，以及专门比较 PRD/architecture/implementation 是否一致的 alignment verifier。 |
| `helper` | 已覆盖代码探索、外部资料、视觉文档、摘要、标题和上下文压缩。 | 缺少头脑风暴参与 agent、memory/context retriever、artifact indexer、trace summarizer，以及长任务/CI/log watcher 这类 monitor helper。 |

如果将来要加第五类，优先观察 `monitor`。只有当长期 watch agent 需要独立生命周期、订阅、唤醒和告警策略，且不能作为 helper 的 collaboration trigger 表达时，再把它提升为新 `kind`。现在先放在 `helper` 更稳。

## 协议约束

- Agent 模板的 `entry`、`capability`、permission、`relationships` 和 `orchestration_policy` 都是 Runtime 可读取的协议字段。
- 默认 Agent 选择使用 `entry.primary`、`entry.default` 和 `entry.hidden`，并需要可解释的 tie-breaker。
- UI picker、mention suggestions 和 delegation candidate 使用不同 entry flag。
- Relationship graph 用于解释稳定协作结构，执行仍由 Runtime 展开为 Action、Assignment 或 Handoff。
- Orchestration policy 的每个触发项都需要目标、触发条件、contract、依赖、预算、深度/并发限制和去重键。
- 每个后续 Assignment 都独立推导 authority；后续 Agent 不继承来源 Agent 的权限。
