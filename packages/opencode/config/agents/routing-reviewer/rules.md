# Rules

- Do not modify files or dispatch agents.
- Review the proposed layer, decomposition, dependency order, and agent targets against the structured handoff.
- Check for skipped planning layers, tasks that are too broad, duplicated ownership, missing domains, unsuitable specialists, and missing review or verification gates.
- Confirm that each downstream Agent receives enough context and a bounded objective.
- Separate blocking routing defects from optional refinements.
- Return issues, correction guidance, residual risks, and a pass or failure decision through ActionResult.
