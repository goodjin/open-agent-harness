# RFC: Agent Metadata Control Plane

Status: Draft

Date: 2026-06-02

Owner: TBD

## Summary

Agent metadata should be a Runtime control plane. It lets Harness understand how an Agent is displayed, selected, configured, invoked, constrained, evaluated, chained, recovered and retired.

This RFC proposes a richer Agent metadata model covering:

- identity and catalog display, including logo
- capability, input and output contracts
- instruction files and event-driven model messages
- collaboration policy beyond simple before/after chains
- runtime boundary across programming and non-programming agents
- artifact and completion contracts
- versioning and snapshot rules

The goal is to let Runtime make precise decisions without relying only on prompt wording.

## Motivation

The current Agent model already has `entry`, `capability`, `permission`, `relationships` and `orchestration_policy`. That is enough for basic Agent Manager and delegation, but it leaves several important questions under-specified:

- How does the UI represent an Agent beyond name and description?
- Are inputs and outputs only text formats, or do they express execution contracts?
- How can Agent collaboration express review, arbitration, fallback, fan-out, monitoring and recovery, not only preflight and follow-up?
- How are global rules, project rules and request-level prompt suffixes injected?
- How does Runtime constrain research, business, communication, finance or browser agents, not only coding agents?
- How does Runtime know whether an Agent produced the expected artifact?
- How does Runtime decide that a task is complete?
- What happens when an Agent definition changes while old runs still reference it?

This RFC treats metadata as a structured contract between Agent author, Runtime, UI, evaluator and downstream Agent Sessions.

## Core Principle

Agent metadata describes what Runtime may know and enforce about an Agent. It does not directly grant authority.

Runtime still derives concrete authority for each Assignment from:

- user request
- run policy
- Agent metadata
- current Projection
- permission and gate state
- approval decisions
- budget and visibility constraints

## Proposed Top-Level Shape

```json
{
  "schema_version": "agent.metadata.v1",
  "agent_version": "1.2.0",
  "id": "cross_border_researcher",
  "name": "Cross Border Researcher",
  "description": "Research cross-border product and market opportunities.",
  "persona": "Research with cited sources, separate facts from assumptions, and produce decision-ready summaries.",
  "logo": {
    "uri": "${agent.dir}/logo.svg",
    "alt": "Cross Border Researcher",
    "theme": "auto"
  },
  "entry": {},
  "capability": {},
  "contracts": {},
  "instructions": {},
  "collaboration": {},
  "runtime_boundary": {},
  "completion": {},
  "observability": {},
  "lifecycle": {}
}
```

## Identity And Display

`logo` should be part of identity metadata.

```json
{
  "logo": {
    "uri": "${agent.dir}/logo.svg",
    "alt": "Cross Border Researcher",
    "theme": "auto",
    "hash": "sha256:..."
  }
}
```

Field meanings:

- `uri`: local path, package path, data URI or trusted remote URI.
- `alt`: accessible label for UI and export.
- `theme`: `light`, `dark` or `auto`.
- `hash`: optional integrity value for package or remote assets.

Runtime should validate local paths and remote allowlists. UI should fall back to initials or a generated icon if the logo cannot be loaded.

## Capability, Inputs And Outputs

Input and output are not just content formats. They are contracts.

An input contract describes what an Agent can consume:

- source type: user request, Artifact, Memory, URL, file, event, decision, API payload
- content type: text, JSON, markdown, image, PDF, CSV, code patch, browser state, email thread
- schema: JSON Schema, named schema ref or domain-specific validator
- semantic requirements: freshness, citations, language, scope, confidence
- visibility and privacy requirements

An output contract describes what an Agent should produce:

- artifact type
- content type
- schema or validator
- required evidence
- downstream consumers
- visibility
- completion role

Example:

```json
{
  "contracts": {
    "input": [
      {
        "name": "product_brief",
        "required": true,
        "source": ["user", "artifact"],
        "content_type": ["text/markdown", "application/json"],
        "schema_ref": "schema://product_brief.v1",
        "constraints": ["include_target_market", "include_price_band"]
      }
    ],
    "output": [
      {
        "name": "market_research_report",
        "required": true,
        "artifact_type": "research_report",
        "content_type": "text/markdown",
        "schema_ref": "schema://market_research_report.v1",
        "evidence": ["source_refs", "search_queries"],
        "visibility": {
          "model": "summary",
          "user": "full",
          "trace": "summary"
        }
      }
    ]
  }
}
```

Runtime uses these contracts in four places:

1. Before Assignment: validate whether required inputs exist. If missing, block, ask user or trigger another Agent.
2. Context construction: include only allowed input refs and required instructions.
3. After execution: validate output schema, artifact existence and evidence.
4. Routing: choose downstream Agents whose input contract matches available artifacts.

Prompt guidance helps the model, but control should come from Runtime validation and gates.

## Instruction Files And Event Messages

Global rules should not be a separate boolean. They should be explicit instruction file paths.

A template creator can include global rules by default. If an Agent should not use them, the template simply omits those paths.

```json
{
  "instructions": {
    "files": [
      {
        "path": "${global.rules}/base.md",
        "role": "system",
        "required": true
      },
      {
        "path": "${project.rules}/security.md",
        "role": "system",
        "required": false
      },
      {
        "path": "${agent.dir}/rules.md",
        "role": "system",
        "required": true
      }
    ],
    "model_messages": [
      {
        "on": "before_model_call",
        "position": "suffix",
        "content": "不许偷懒，先确认完成条件，再给出结论。"
      },
      {
        "on": "output_validation_failed",
        "position": "observation",
        "content": "你的输出没有满足结构要求。请根据 Runtime 提供的错误修正，不要改写无关内容。"
      }
    ]
  }
}
```

Supported path variables:

- `${agent.dir}`
- `${project.root}`
- `${workspace.root}`
- `${global.rules}`
- `${user.home}`
- `${run.dir}`

Runtime should resolve variables before model context construction. Missing required files block the Assignment. Missing optional files produce diagnostics.

`model_messages` are event-driven Runtime messages. They are not user messages and should be recorded in trace. Useful events include:

- `before_model_call`
- `after_tool_result`
- `output_validation_failed`
- `budget_near_limit`
- `dependency_completed`
- `dependency_failed`
- `risk_detected`
- `completion_rejected`

This gives the system a controlled way to reply to the model when something happens, instead of hiding operational feedback inside one static prompt.

## Collaboration Policy

Simple `upstream` and `downstream` relations are useful, but they are too narrow. Agent collaboration should be modeled as event-conditioned coordination.

Proposed shape:

```json
{
  "collaboration": {
    "edges": [
      {
        "id": "collect_web_sources",
        "kind": "prerequisite",
        "trigger": "before_assignment_start",
        "target": {
          "executor": "agent",
          "capability": "web_research"
        },
        "required": true,
        "order": "sequential",
        "contract": {
          "goal": "Collect current source information before market synthesis.",
          "artifacts": ["source_brief"],
          "evidence": ["source_urls", "search_queries"]
        }
      },
      {
        "id": "verify_implementation",
        "kind": "verifier",
        "trigger": "after_artifact_created",
        "when": {
          "artifact_type": "patch"
        },
        "target": {
          "executor": "agent",
          "capability": "verification"
        },
        "required": true
      },
      {
        "id": "resolve_review_conflict",
        "kind": "arbiter",
        "trigger": "on_conflict",
        "target": {
          "executor": "agent",
          "capability": "technical_review"
        }
      },
      {
        "id": "fallback_general_research",
        "kind": "fallback",
        "trigger": "on_target_unavailable",
        "target": {
          "executor": "agent",
          "capability": "general_research"
        }
      }
    ],
    "limits": {
      "max_depth": 3,
      "max_parallel": 4,
      "dedupe_key": "cross_border_research_chain"
    }
  }
}
```

Recommended edge kinds:

- `prerequisite`: produces input before current Agent starts.
- `verifier`: checks output or evidence.
- `reviewer`: reviews quality, correctness, compliance or risk.
- `arbiter`: resolves conflicting outputs or decisions.
- `fallback`: runs when preferred Agent or service is unavailable.
- `recovery`: diagnoses and repairs a failure.
- `monitor`: observes long-running state and triggers on condition.
- `splitter`: decomposes work into multiple Assignments.
- `aggregator`: merges parallel results.
- `escalation`: hands off to human owner or higher-authority Agent.
- `peer`: runs in parallel for diversity or comparison.
- `blocker`: prevents unsafe combinations.

Runtime expands matching edges into Action, Assignment or Handoff. Agent Sessions still do not call each other directly.

## Runtime Boundary

Permissions should cover more than programming tools.

Proposed `runtime_boundary`:

```json
{
  "runtime_boundary": {
    "resource_classes": [
      "filesystem",
      "network",
      "browser",
      "email",
      "calendar",
      "database",
      "cloud",
      "payment",
      "crm",
      "messaging",
      "human_contact",
      "secret",
      "personal_data"
    ],
    "actions": {
      "read": ["web:*", "artifact:*"],
      "write": ["artifact:research_report"],
      "execute": ["search", "browser.open"],
      "communicate": [],
      "publish": [],
      "spend": [],
      "delete": [],
      "approve": []
    },
    "network": {
      "allow": ["amazon.com", "sellercentral.amazon.com", "statista.com"],
      "deny": ["unknown_file_download"]
    },
    "data": {
      "max_classification": "internal",
      "redact": ["secret", "credential", "personal_data"]
    },
    "approval": {
      "required_for": ["external_post", "payment", "delete", "email_send"]
    },
    "rate_limits": {
      "requests_per_minute": 30,
      "max_cost_usd": 5
    }
  }
}
```

This supports coding, research, operations, customer support, marketing, finance, legal review and personal assistant workflows. Runtime can derive concrete authority from this boundary and the current Assignment.

## Artifact Contract

Artifacts should be typed runtime records, not loose model text.

Expected artifact:

```json
{
  "name": "test_report",
  "artifact_type": "verification_report",
  "required": true,
  "schema_ref": "schema://verification_report.v1",
  "must_include": ["commands", "exit_codes", "failures", "summary"],
  "evidence": ["terminal_output", "changed_files"],
  "consumer": ["technical_reviewer"],
  "completion_role": "required"
}
```

Actual artifact record:

```json
{
  "id": "artifact_test_report_01",
  "name": "test_report",
  "artifact_type": "verification_report",
  "producer": "assignment:assign_code_test",
  "status": "available",
  "uri": "artifact://assign_code_test/test_report",
  "schema_ref": "schema://verification_report.v1",
  "validation": {
    "status": "passed",
    "validator": "schema://verification_report.v1"
  },
  "summary": "Unit tests passed for the changed session runner files.",
  "evidence": ["event:tool.bun_test.completed"]
}
```

Runtime uses artifact contracts to:

- validate whether output exists
- route downstream Agents
- construct concise model context
- show progress in UI
- decide task completion
- store audit evidence
- promote reusable memory when allowed

The model receives artifact expectations in the Context Bundle, but artifact acceptance is a Runtime decision.

## Completion Contract

Task completion should not depend only on the model saying "done".

Proposed shape:

```json
{
  "completion": {
    "mode": "runtime_verified",
    "criteria": [
      "market_research_report exists",
      "report includes at least five cited sources",
      "all required prerequisite assignments completed",
      "no blocking unresolved issues remain"
    ],
    "required_artifacts": ["market_research_report"],
    "required_evidence": ["source_refs", "search_queries"],
    "gates": [
      {
        "type": "schema",
        "target": "artifact:market_research_report"
      },
      {
        "type": "evidence",
        "target": "source_refs"
      }
    ],
    "allow_partial": true
  }
}
```

Runtime completion flow:

1. Agent may declare `done` with result summary and artifact refs.
2. Runtime checks dependency graph, required artifacts, output schemas, evidence, gates, unresolved issues and required collaboration edges.
3. If checks pass, Runtime marks Assignment or Run `completed`.
4. If useful artifacts exist but required checks fail, Runtime marks `partial`.
5. If required input, approval or decision is missing, Runtime marks `blocked` or `waiting_user`.
6. If execution fails and recovery policy is exhausted, Runtime marks `failed`.
7. If completion is rejected, Runtime can inject an event message to the model and continue, or route to a verifier/reviewer.

Completion can be checked by deterministic validators, tool results, evaluator Agents, human decisions or service callbacks. The contract should state which checks are required.

## Versioning

Version fields serve different purposes:

- `schema_version`: tells Runtime how to parse metadata.
- `agent_version`: describes behavior/configuration version.
- `revision`: content hash or immutable package revision.
- `compatibility`: declares compatible Runtime or protocol versions.
- `deprecated`: marks an Agent as no longer recommended.
- `replacement`: points to a successor Agent.

Old versions should be preserved as immutable snapshots when used by a run.

Recommended rules:

- Running sessions stay pinned to the Agent snapshot they started with.
- Historical runs keep `agent_snapshot_ref` for audit, replay and evaluation.
- New sessions use the active version unless a workflow explicitly pins another version.
- Patch/minor updates may replace the active version.
- Major behavior changes should keep the previous version available until active runs finish or migrate.
- Deprecated Agents can remain hidden from normal routing while still available for replay.

This prevents a later Agent edit from changing the meaning of an old trace.

## Minimal Agent Example

```json
{
  "schema_version": "agent.metadata.v1",
  "agent_version": "1.0.0",
  "id": "code_test",
  "name": "Code Test",
  "description": "Run validation and produce a concise test report.",
  "persona": "Verify changed behavior with focused commands and preserve evidence.",
  "logo": {
    "uri": "${agent.dir}/logo.svg",
    "alt": "Code Test"
  },
  "entry": {
    "primary": false,
    "delegable": true,
    "mentionable": true,
    "default": false,
    "hidden": false
  },
  "capability": {
    "purpose": "verification",
    "tags": ["test", "validation", "evidence"],
    "cost": "low",
    "writes": false
  },
  "instructions": {
    "files": [
      {
        "path": "${global.rules}/engineering.md",
        "role": "system",
        "required": true
      },
      {
        "path": "${agent.dir}/rules.md",
        "role": "system",
        "required": true
      }
    ],
    "model_messages": [
      {
        "on": "before_model_call",
        "position": "suffix",
        "content": "Do not claim verification without command evidence."
      }
    ]
  },
  "contracts": {
    "input": [
      {
        "name": "patch",
        "required": true,
        "source": ["artifact"],
        "artifact_type": "patch"
      }
    ],
    "output": [
      {
        "name": "test_report",
        "required": true,
        "artifact_type": "verification_report",
        "schema_ref": "schema://verification_report.v1",
        "evidence": ["commands", "exit_codes"]
      }
    ]
  },
  "completion": {
    "mode": "runtime_verified",
    "required_artifacts": ["test_report"],
    "required_evidence": ["commands", "exit_codes"],
    "allow_partial": true
  }
}
```

## RFC Completeness Bar

To submit this as an RFC, the proposal should include:

- problem statement and motivation
- field taxonomy and top-level schema
- default values and validation rules
- path variable resolution rules
- event-triggered model message semantics
- input/output/artifact contract semantics
- collaboration trigger and edge semantics
- runtime boundary and authority derivation rules
- completion contract and state transition rules
- versioning and snapshot rules
- three examples: coding, research and non-programming business Agent
- migration path from current `01-agent-model-and-authoring.md`
- tests required for schema, loader, Agent Manager, routing and completion
- explicit non-goals

## Non-Goals

- This RFC does not define a full workflow language.
- This RFC does not bind metadata to a specific UI layout.
- This RFC does not let Agent Sessions directly message each other.
- This RFC does not require every Agent to fill every field.
- This RFC does not make prompt text a substitute for Runtime validation.

## Submission Plan

The repository has no visible formal RFC process. A practical process would be:

1. Keep this file under `docs/harness-protocol/`.
2. Update `00-harness-governance-protocol.md` document map to reference the RFC.
3. Update `01-agent-model-and-authoring.md` only after the RFC direction is accepted.
4. Add JSON examples under agent fixtures if implementation starts.
5. Open a PR against `dev` with title `[RFC] Agent metadata control plane`.
6. In the PR description, list decisions requested from reviewers:
   - Should `collaboration` replace or subsume `relationships`?
   - Should `instructions.files` be the only rule injection mechanism?
   - Which runtime boundary resource classes are P0?
   - Should completion contract be part of Agent metadata, Assignment contract or both?
   - What snapshot retention policy is acceptable?
7. After review, split implementation into smaller PRs: schema, loader, UI, Runtime expansion, completion gate and tests.

## Acceptance Estimate

As a protocol RFC, this has a good chance if scoped as a direction-setting draft. Current docs already support Agent metadata, Runtime-managed coordination, Artifact, Trace and Completion concepts, so the proposal fits the existing architecture.

Estimated acceptance:

- 75% as an RFC draft for review.
- 60% as the next protocol direction if `collaboration`, `instructions` and `completion` are kept modular.
- 35% if submitted as a single implementation requirement for all fields at once.

The main risk is scope. The proposal should be accepted as a metadata control-plane framework, then implemented in phases.
