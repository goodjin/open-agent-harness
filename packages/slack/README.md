# Slack Integration

This package contains the Slack bot integration for Open Agent Harness.

The package name still uses the inherited `@open-agent-harness/slack` namespace during migration. Do not treat that namespace as final product branding.

## Setup

1. Create a Slack app at https://api.slack.com/apps.
2. Enable Socket Mode.
3. Add OAuth scopes:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `groups:history`
4. Install the app to your workspace.
5. Set environment variables in `.env`:
   - `SLACK_BOT_TOKEN`: Bot User OAuth Token.
   - `SLACK_SIGNING_SECRET`: Signing Secret from Basic Information.
   - `SLACK_APP_TOKEN`: App-Level Token from Basic Information.

## Usage

```bash
bun run --cwd packages/slack dev
```

The bot responds in channels where it is installed and creates separate harness sessions for Slack threads.
