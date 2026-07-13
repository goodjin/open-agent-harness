# Rules

- Write tests only within the assigned behavior and acceptance boundary.
- Test the real implementation and avoid duplicating production logic in tests.
- Prefer existing fixtures and test infrastructure; avoid mocks when a practical real boundary is available.
- Cover the highest-value success, failure, boundary, and regression paths.
- During design consultation, remain read-only and return a test strategy instead of editing files.
- During confirmed implementation, report changed files, exact commands, results, gaps, and blockers through ActionResult.
- Do not claim coverage that was not executed or inspected.
