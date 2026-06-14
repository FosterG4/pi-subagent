/**
 * Agent discovery and configuration
 *
 * Discovers agents from three sources (lowest to highest priority):
 * 1. Bundled agents (shipped with the @fosterg4/pi-subagent package)
 * 2. User agents (~/.pi/agent/agents/)
 * 3. Project agents (.pi/agents/ - requires "project" or "both" scope)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Resolve the directory where the package's bundled agents live.
 * Uses import.meta.url to find the package directory at runtime.
 */
function getBundledAgentsDir(): string | null {
	try {
		const currentFile = fileURLToPath(import.meta.url);
		const packageDir = path.dirname(currentFile);
		const bundledDir = path.join(packageDir, "agents");
		return fs.existsSync(bundledDir) ? bundledDir : null;
	} catch {
		return null;
	}
}

function loadAgentsFromDir(
	dir: string,
	source: AgentConfig["source"],
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const name = String(frontmatter.name);
		const description = String(frontmatter.description);

		const toolsStr = frontmatter.tools;
		const tools =
			typeof toolsStr === "string"
				? toolsStr
						.split(",")
						.map((t: string) => t.trim())
						.filter(Boolean)
				: undefined;

		const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;

		// Parse contract schemas (optional)
		const inputSchema =
			frontmatter.inputSchema && typeof frontmatter.inputSchema === "object"
				? (frontmatter.inputSchema as Record<string, unknown>)
				: undefined;

		const outputSchema =
			frontmatter.outputSchema && typeof frontmatter.outputSchema === "object"
				? (frontmatter.outputSchema as Record<string, unknown>)
				: undefined;

		agents.push({
			name,
			description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model,
			systemPrompt: body,
			source,
			filePath,
			inputSchema,
			outputSchema,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledDir = getBundledAgentsDir();

	// Load agents from each source
	const bundledAgents = bundledDir ? loadAgentsFromDir(bundledDir, "bundled") : [];
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	// Merge with override priority: project > user > bundled
	const agentMap = new Map<string, AgentConfig>();

	// Lowest priority: bundled
	for (const agent of bundledAgents) {
		agentMap.set(agent.name, agent);
	}
	// Middle priority: user (overrides bundled)
	if (scope !== "project") {
		for (const agent of userAgents) {
			agentMap.set(agent.name, agent);
		}
	}
	// Highest priority: project (overrides user and bundled)
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of projectAgents) {
			agentMap.set(agent.name, agent);
		}
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
	};
}

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed
			.map((a) => `${a.name} (${a.source}): ${a.description}`)
			.join("; "),
		remaining,
	};
}