# ACP Implementation

This directory contains the Agent Client Protocol implementation for Open Agent Harness.

The runtime package path is still `packages/opencode` during migration, but ACP should be documented and treated as part of the Open Agent Harness protocol surface.

## Architecture

- `agent.ts`: implements the `Agent` interface from `@agentclientprotocol/sdk`, handles initialization, capability negotiation, session creation, session loading, and prompts.
- `client.ts`: implements client-side file operations, permission requests, and terminal capability placeholders.
- `session.ts`: maps ACP sessions to internal harness sessions and keeps working-directory context.
- `server.ts`: starts the JSON-RPC stdio server and manages lifecycle.
- `types.ts`: internal ACP type helpers.

## Usage

Start the ACP server in the current directory:

```bash
open-agent-harness acp
```

Start in a specific directory:

```bash
open-agent-harness acp --cwd /path/to/project
```

For local repository development:

```bash
bun run --cwd packages/opencode --conditions=browser ./src/index.ts acp
```

## Question Tool Opt-In

ACP excludes `QuestionTool` by default.

```bash
OPENCODE_ENABLE_QUESTION_TOOL=1 open-agent-harness acp
```

The environment variable name is retained for migration compatibility. Enable this only for ACP clients that support interactive question prompts.

## Programmatic Start

```typescript
import { ACPServer } from "./acp/server"

await ACPServer.start()
```

## Zed Integration

Example Zed configuration:

```json
{
  "agent_servers": {
    "Open Agent Harness": {
      "command": "open-agent-harness",
      "args": ["acp"]
    }
  }
}
```

For local development, point `command` at a wrapper script that runs `bun run --cwd packages/opencode --conditions=browser ./src/index.ts acp`.

## Protocol Coverage

Implemented:

- `initialize` with protocol version negotiation
- capability advertisement
- `session/new`
- basic `session/load`
- working-directory context
- MCP server configuration support
- `session/prompt`
- text and resource content blocks
- file read and write client calls
- permission request bridge

Limitations:

- Responses are not fully streamed through `session/update`.
- Tool execution progress reporting is incomplete.
- Session mode switching is not complete.
- Authentication is a placeholder.
- Terminal support is a placeholder.
- `session/load` does not restore full conversation history.

## Testing

Run from `packages/opencode`:

```bash
bun test test/acp.test.ts
```

Manual stdio smoke test:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | bun run --conditions=browser ./src/index.ts acp
```

## References

- [ACP specification](https://agentclientprotocol.com/)
- [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
