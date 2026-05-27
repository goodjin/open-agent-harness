# Open Agent Harness GitHub Action

This package contains the GitHub Action integration for Open Agent Harness.

The action is still in migration from upstream opencode. Some code paths, trigger phrases, and package names may still use `opencode` for compatibility. Treat this package as experimental until the GitHub app identity, workflow examples, and published action namespace are finalized for Open Agent Harness.

## What It Does

The action lets maintainers invoke the harness from GitHub issues, pull requests, and review comments. It reads the relevant thread or diff context, runs inside a GitHub Actions runner, and can respond or push changes depending on the event and token permissions.

Current trigger phrases are implemented in code as:

- `/opencode`
- `/oc`

These are legacy compatibility triggers. Do not document them as final Open Agent Harness product branding in external release material.

## Typical Requests

Explain an issue:

```text
/oc explain this issue
```

Ask for a fix:

```text
/oc fix this
```

Request a PR change:

```text
Delete the unused import /oc
```

Request a line-specific review change from the GitHub PR "Files changed" view:

```text
/oc add error handling here
```

## Manual Workflow Skeleton

Use this as a local development starting point only. Replace the action reference with the final Open Agent Harness action location before publishing.

```yaml
name: open-agent-harness

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  harness:
    if: |
      contains(github.event.comment.body, '/oc') ||
      contains(github.event.comment.body, '/opencode')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run Open Agent Harness
        uses: ./github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          model: anthropic/claude-sonnet-4-20250514
          use_github_token: true
```

## Local Development

Run the action package directly from a test repository:

```bash
MODEL=anthropic/claude-sonnet-4-20250514 \
  ANTHROPIC_API_KEY=sk-ant-api03-placeholder \
  GITHUB_RUN_ID=dummy \
  MOCK_TOKEN=github_pat_placeholder \
  MOCK_EVENT='{"eventName":"issue_comment",...}' \
  bun /path/to/open-agent-harness/github/index.ts
```

Inputs:

- `MODEL`: model identifier used by the harness.
- `ANTHROPIC_API_KEY`: example provider key; use the provider key required by your selected model.
- `GITHUB_RUN_ID`: dummy value for local action emulation.
- `MOCK_TOKEN`: GitHub personal access token with access to the test repository.
- `MOCK_EVENT`: mock GitHub event payload.

## Mock Events

Issue comment:

```bash
MOCK_EVENT='{"eventName":"issue_comment","repo":{"owner":"OWNER","repo":"REPO"},"actor":"USER","payload":{"issue":{"number":4},"comment":{"id":1,"body":"/oc summarize thread"}}}'
```

PR issue comment:

```bash
MOCK_EVENT='{"eventName":"issue_comment","repo":{"owner":"OWNER","repo":"REPO"},"actor":"USER","payload":{"issue":{"number":4,"pull_request":{}},"comment":{"id":1,"body":"/oc summarize this PR"}}}'
```

PR review comment:

```bash
MOCK_EVENT='{"eventName":"pull_request_review_comment","repo":{"owner":"OWNER","repo":"REPO"},"actor":"USER","payload":{"pull_request":{"number":7},"comment":{"id":1,"body":"/oc add error handling","path":"src/Button.tsx","diff_hunk":"@@ -1,3 +1,4 @@","line":47,"original_line":45,"position":10,"commit_id":"abc123","original_commit_id":"def456"}}}'
```

## Migration Notes

- The package directory is `github`.
- The current code still accepts `/opencode`.
- Some generated links and social-card URLs still reference upstream opencode infrastructure and need code changes before public Open Agent Harness release.
