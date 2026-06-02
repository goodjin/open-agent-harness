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
- `relationships`：默认不存在。用于声明该 Agent 与其他 Agent 或 capability 的稳定协作关系，例如上游依赖、推荐下游、互斥关系或替代候选。
- `orchestration_policy`：默认不存在。用于声明 Runtime 可以围绕该 Agent Session 评估和创建的前置、后置、恢复、审查、仲裁等后续 Action / Assignment。

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

## 内置 Agent Entry

内置 Agent 应使用以下 entry/capability 形态。`purpose` 是 routing hint，`writes` 和 `cost` 是 capability metadata，不直接授予执行权限。

| Agent | Entry | 用途 / Capability |
|---|---|---|
| `accessibility_reviewer` | not primary、delegable、mentionable、not default、visible | UI 可访问性审查：语义、键盘访问、label、focus、contrast 和 assistive technology compatibility。purpose `accessibility_review`；writes false；cost low |
| `api_contract_reviewer` | not primary、delegable、mentionable、not default、visible | API contract、schema、兼容性、SDK 影响、错误语义和前后端边界审查。purpose `api_contract_review`；writes false；cost medium |
| `backend_developer` | not primary、delegable、mentionable、not default、visible | 后端实现、API、数据模型、auth、permissions 和 service integration。purpose `backend_implementation`；writes true；cost medium |
| `code_debugger` | not primary、delegable、mentionable、not default、visible | 复现失败、缩小问题范围、定位根因和建议下一步。purpose `debugging`；writes false；cost medium |
| `code_developer` | primary、delegable、mentionable、not default、visible | 主要开发 Agent，用于代码修改和验证。purpose `implementation`；writes true；cost medium |
| `code_migration_runner` | primary、delegable、mentionable、not default、visible | 跨文件迁移、重命名、API migration 和架构迁移。purpose `migration`；writes true；cost high |
| `code_refactorer` | primary、delegable、mentionable、not default、visible | 低风险、保持行为不变的重构和聚焦验证。purpose `refactoring`；writes true；cost medium |
| `code_researcher` | not primary、delegable、mentionable、not default、visible | 文件发现、模式追踪，以及回答代码在哪里或如何实现。purpose `code_search`；writes false；cost low |
| `code_test` | not primary、delegable、mentionable、not default、visible | 运行 validation commands、解释失败并建议下一步。purpose `verification`；writes false；cost low |
| `data_migration_runner` | primary、delegable、mentionable、not default、visible | 数据迁移、schema transition、backfill、一致性检查和 rollback-aware migration plan。purpose `data_migration`；writes true；cost high |
| `database_developer` | not primary、delegable、mentionable、not default、visible | 数据库 schema、migration、query、index、transaction 和数据一致性。purpose `database`；writes true；cost medium |
| `dependency_maintainer` | not primary、delegable、mentionable、not default、visible | 依赖升级、lockfile、兼容性、breaking changes 和依赖安全风险。purpose `dependency_maintenance`；writes true；cost medium |
| `devops_developer` | not primary、delegable、mentionable、not default、visible | CI/CD、build scripts、deployment config、本地服务、环境变量和运维设置。purpose `devops`；writes true；cost medium |
| `docs_maintainer` | not primary、delegable、mentionable、not default、visible | 维护反映当前代码和 workflow 的工程文档。purpose `documentation`；writes true；cost low |
| `external_researcher` | not primary、delegable、mentionable、not default、visible | 官方文档、远程仓库、外部库和实现示例研究。purpose `source_research`；writes false；cost low |
| `focused_developer` | not primary、delegable、mentionable、not default、visible | 聚焦 delegated task 的实现，不承担广义 orchestration。purpose `focused_execution`；writes true；cost medium |
| `frontend_developer` | not primary、delegable、mentionable、not default、visible | 前端实现、UI 行为、样式、可访问性和浏览器验证。purpose `frontend_implementation`；writes true；cost medium |
| `general_developer` | primary、delegable、mentionable、default、visible | 默认通用 Agent，适合没有更明确 specialist 的普通任务。purpose `general`；writes true；cost medium |
| `general_researcher` | not primary、delegable、mentionable、not default、visible | 广泛研究、复杂代码库问题和并行工作单元。purpose `general_research`；writes true；cost medium |
| `incident_responder` | primary、delegable、mentionable、not default、visible | 事故响应、故障 triage、mitigation、verification 和后续复盘。purpose `incident_response`；writes true；cost high |
| `multimodal_reader` | not primary、delegable、mentionable、not default、visible | PDF、图片、图表、diagram 和视觉文档分析。purpose `media_interpretation`；writes false；cost low |
| `observability_developer` | not primary、delegable、mentionable、not default、visible | logging、metrics、tracing、audit events、health checks 和 operational diagnostics。purpose `observability`；writes true；cost medium |
| `performance_reviewer` | not primary、delegable、mentionable、not default、visible | frontend、backend、runtime、database 和 build workflow 的性能审查。purpose `performance_review`；writes false；cost medium |
| `plan_builder` | primary、delegable、mentionable、not default、visible | 通过访谈、研究和整理创建可执行工作计划。purpose `plan_building`；writes true；cost high |
| `plan_executor` | primary、delegable、mentionable、not default、visible | 多步任务执行与验证协调。purpose `plan_execution`；writes true；cost high |
| `plan_reviewer` | not primary、delegable、mentionable、not default、visible | 审查计划是否可执行、引用是否有效、阻塞是否真实。purpose `plan_review`；writes false；cost medium |
| `protocol_runner` | primary、not delegable、mentionable、not default、visible | Agent Protocol DSL 的结构化声明和协议运行观察入口。purpose `protocol_orchestration`；writes false；cost low |
| `release_runner` | primary、delegable、mentionable、not default、visible | release preparation、versioning、changelog、artifact、dry run、publishing 和 post-release verification。purpose `release`；writes true；cost high |
| `release_test` | not primary、delegable、mentionable、not default、visible | release artifact、version、changelog、dry run output、publish readiness 和 rollback evidence 验证。purpose `release_verification`；writes false；cost medium |
| `requirements_clarifier` | not primary、delegable、mentionable、not default、visible | 在 planning 或 implementation 前澄清意图、隐藏需求、歧义、风险和 planning directives。purpose `requirements_clarification`；writes false；cost medium |
| `security_reviewer` | not primary、delegable、mentionable、not default、visible | security、permission、sandbox、secret 和 data-access 审查。purpose `security_review`；writes false；cost medium |
| `session_compactor` | not primary、not delegable、not mentionable、not default、hidden | 长会话 continuation summary。purpose `system_compaction`；writes false；cost low |
| `session_summarizer` | not primary、not delegable、not mentionable、not default、hidden | 隐藏系统 Agent，用于创建 session summaries。purpose `system_summary`；writes false；cost low |
| `session_title_writer` | not primary、not delegable、not mentionable、not default、hidden | 根据首个用户 prompt 创建短 session title。purpose `system_title`；writes false；cost low |
| `task_orchestrator` | primary、delegable、mentionable、not default、visible | 主 orchestrator：识别意图、委托 specialist、验证工作并推进交付。purpose `orchestration`；writes true；cost high |
| `task_planner` | primary、delegable、mentionable、not default、visible | 只读规划 Agent，用于分析、设计、审查和实施计划。purpose `planning_analysis`；writes false；cost low |
| `technical_reviewer` | not primary、delegable、mentionable、not default、visible | 架构、复杂 debugging、tradeoff 和实现后技术审查顾问。purpose `technical_review`；writes false；cost high |
| `ux_reviewer` | not primary、delegable、mentionable、not default、visible | UX flow、information architecture、interaction clarity、empty states 和用户摩擦审查。purpose `ux_review`；writes false；cost low |
| `workflow_runner` | primary、not delegable、mentionable、not default、visible | 创建、保存、更新和启动 Workflow 资产；Workflow Run materialize 为统一 Action Graph 执行。purpose `workflow_profile_management`；writes true；cost low |

## 协议约束

- Agent 模板的 `entry`、`capability`、permission、`relationships` 和 `orchestration_policy` 都是 Runtime 可读取的协议字段。
- 默认 Agent 选择使用 `entry.primary`、`entry.default` 和 `entry.hidden`，并需要可解释的 tie-breaker。
- UI picker、mention suggestions 和 delegation candidate 使用不同 entry flag。
- Relationship graph 用于解释稳定协作结构，执行仍由 Runtime 展开为 Action、Assignment 或 Handoff。
- Orchestration policy 的每个触发项都需要目标、触发条件、contract、依赖、预算、深度/并发限制和去重键。
- 每个后续 Assignment 都独立推导 authority；后续 Agent 不继承来源 Agent 的权限。
