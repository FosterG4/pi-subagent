---
description: Scout investigates, planner creates plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to investigate: $@ — return structured findings
2. Then, use the "planner" agent to create an implementation plan from the scout's structured findings (use {previous} placeholder)

Execute this as a chain, passing structured output between steps via {previous}. Do NOT implement — only scout and plan.