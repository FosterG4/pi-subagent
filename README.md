# @fosterg4/pi-subagent

[![npm version](https://img.shields.io/npm/v/@fosterg4/pi-subagent)](https://www.npmjs.com/package/@fosterg4/pi-subagent)

Delegate complex tasks to specialized sub-agents with isolated context windows, structured JSON handoff, contract schemas, and live TUI streaming — all within [pi](https://pi.dev).

## Features

- **Isolated context** — Each subagent runs in a separate `pi` process with its own context window
- **Three execution modes** — Single, parallel (max 8, concurrency 4), and chain (sequential with data handoff)
- **Structured JSON handoff** — Agents pass typed data between each other, not freeform markdown
- **Contract schemas** — `inputSchema`/`outputSchema` in agent frontmatter ensures valid handoffs
- **Live TUI streaming** — Subagent tool calls (read, bash, grep, etc.) stream in real-time
- **Bundled agents** — 4 built-in agents ready to use: scout, planner, reviewer, worker
- **Workflow prompts** — `/implement`, `/scout-and-plan`, `/implement-and-review` commands

## Installation

```bash
pi install npm:@fosterg4/pi-subagent
```

For a quick test without installing:

```bash
pi -e npm:@fosterg4/pi-subagent
```

## Usage

### Single agent

Ask the LLM to use a subagent:

```
Use scout to find all authentication code in the project
```

The LLM will call the `subagent` tool with `{ agent: "scout", task: "..." }`.

### Parallel execution

```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow

```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts

```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Bundled Agents

| Agent | Purpose | Default Model |
|-------|---------|---------------|
| `scout` | Fast codebase recon — returns structured findings | claude-haiku-4-5 |
| `planner` | Creates implementation plans from context & requirements | claude-sonnet-4-5 |
| `reviewer` | Code review — quality, security, maintainability | claude-sonnet-4-5 |
| `worker` | General-purpose implementation with full capabilities | claude-sonnet-4-5 |

Each agent has a defined `inputSchema` and `outputSchema` in its frontmatter, ensuring structured data flows between chained agents.

## Tool Parameters

The `subagent` tool accepts three mutually exclusive modes:

### Single mode

```json
{
  "agent": "scout",
  "task": "Find all authentication code",
  "cwd": "/optional/working/directory"
}
```

### Parallel mode

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find models" },
    { "agent": "scout", "task": "Find providers" }
  ]
}
```

### Chain mode

```json
{
  "chain": [
    { "agent": "scout", "task": "Investigate the codebase" },
    { "agent": "planner", "task": "Create a plan from: {previous}" }
  ]
}
```

### Common options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentScope` | `"user"`, `"project"`, `"both"` | `"user"` | Which agent directories to search |
| `confirmProjectAgents` | `boolean` | `true` | Prompt before running project agents |
| `cwd` | `string` | current dir | Working directory for subprocess |

## Custom Agents

Create your own agents as `.md` files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
inputSchema:
  type: object
  properties:
    query:
      type: string
  required: [query]
outputSchema:
  type: object
  properties:
    result:
      type: string
  required: [result]
---

System prompt for the agent goes here.
```

**Agent locations** (priority: project > user > bundled):
- `~/.pi/agent/agents/*.md` — User-level (always loaded)
- `.pi/agents/*.md` — Project-level (requires `agentScope: "project"` or `"both"`)
- Bundled with package — Lowest priority, always available

## Security

- **User agents** (`~/.pi/agent/agents/`): Always trusted
- **Project agents** (`.pi/agents/`): Requires confirmation prompt before execution
- **Bundled agents**: Trusted by virtue of package installation

## Development

```bash
# Clone and test locally
git clone https://github.com/fosterg4/pi-subagent.git
cd pi-subagent

# Test with pi
pi -e ./index.ts

# Publish
npm publish --access public
```

## License

MIT