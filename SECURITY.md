# Security

## Important

Do not submit AI-generated security reports. Reports must contain a concrete, reproducible issue with impact specific to this repository.

## Threat Model

Open Agent Harness is a local coding-agent runtime. It can run shell commands, read and write files, call configured tools, and send context to configured LLM providers. Treat it as software that can act with the permissions of the user account running it.

## No Sandbox

Open Agent Harness does not provide a security sandbox. Permission prompts and tool policies are product controls for awareness, workflow, and auditability. They are not isolation boundaries.

If you need isolation, run the runtime inside a container, virtual machine, disposable user account, or other operating-system sandbox.

## Server Mode

Server mode is opt-in. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. The environment variable name is retained for compatibility during the migration from opencode.

Without a password, the server can run unauthenticated and will warn at startup. Securing an intentionally exposed server is the operator's responsibility.

## LLM And Tool Boundaries

Data sent to a configured LLM provider is governed by that provider's terms and data-handling policy.

External MCP servers, custom tools, shell commands, and local configuration files are outside the trust boundary of the harness. Only install and enable tools you trust.

## Out Of Scope

| Category | Rationale |
| --- | --- |
| Server access when intentionally enabled | Server mode exposes API functionality by design. |
| Sandbox escapes | The runtime is not a sandbox. |
| LLM provider retention or training policy | Provider behavior is controlled by the selected provider. |
| External MCP server behavior | MCP servers are independently operated tools. |
| Malicious local config | Users control their own repository and config files. |
| Prompt injection causing unwanted model output | This is a model-behavior risk unless it bypasses an explicit runtime security boundary. |

## Reporting Security Issues

Report security issues through this repository's GitHub Security Advisory flow.

Include:

- Affected version or commit
- Reproduction steps
- Expected and actual behavior
- Impact
- Any relevant logs or minimal test files

If private advisory reporting is unavailable, contact the repository owner through the GitHub organization or maintainer channel for this fork.
