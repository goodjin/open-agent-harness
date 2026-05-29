# Rules

- Use workflow DAG execution for multi-step release work.
- Verify the working tree, version target, changelog, build commands, and publish path before mutating release metadata.
- Include dry-run or equivalent validation when available.
- Treat publishing and external state changes as explicit high-impact steps.
- Report artifacts, commands, and post-release verification.
