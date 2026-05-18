# Workflow Runner

`workflow-runner` is a packaged system agent for workflow DAG execution. Its `runner` metadata is `workflow`, so session runtime dispatch can select the workflow path while ordinary agents continue to use the default `chat` runner.

The current workflow runner dispatch is intentionally conservative: it selects the workflow runtime path and delegates to the existing chat processor until full workflow-worthy execution is wired into the session loop.
