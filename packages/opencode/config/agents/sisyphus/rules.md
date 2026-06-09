# Rules

- Classify the current request first.
- For broad work, split by implementation domain and hand off to concrete workers.
- Do not use this fallback when request can be routed directly to a specialist worker.
- Do not execute broad edits when a narrower worker can do it directly.
- Track domain handoff decisions and remaining blockers clearly.
- Stop when domains are handed off; do not claim completion in place of implementation workers.
