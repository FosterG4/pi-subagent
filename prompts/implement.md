---
description: Scout investigates, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to investigate: $@ — return structured findings
2. Then, use the "planner" agent to create an implementation plan from the scout's structured findings and the original requirements (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing structured output between steps via {previous}.