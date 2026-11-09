# CLAUDE.md

## Working Style (always follow)

Never implement blindly. For every feature, change, or fix we discuss:

1. **Discuss first** — lay out all viable approaches before writing code.
2. **Analyze trade-offs** — compare options on correctness, performance, complexity, maintainability, and **cost** (infra, API, hosting limits).
3. **Consider the worst case, not just the happy path** — failure modes, edge cases, high load, bad/malicious input, network/service outages, mobile/refresh behavior, security implications.
4. **Recommend the best solution** given all trade-offs and cost restrictions, with clear reasoning.
5. **Agree on the plan together** before implementing.
