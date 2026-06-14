/**
 * Tests for agents.ts — Agent discovery and configuration
 *
 * Note: agents.ts imports from @earendil-works/pi-coding-agent which is
 * only available inside the pi runtime. For unit testing we mock those
 * imports using a simple spy approach.
 */

import { validateSchema } from "../validate.ts";
import type { AgentConfig, AgentScope } from "../agents.ts";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`❌ ${message}`);
	console.log(`  ✓ ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`❌ ${message}\n    Expected: ${JSON.stringify(expected)}\n    Actual:   ${JSON.stringify(actual)}`,
		);
	}
	console.log(`  ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// Test: AgentConfig interface shape
// ---------------------------------------------------------------------------
function testAgentConfigShape(): void {
	const agent: AgentConfig = {
		name: "test-agent",
		description: "A test agent",
		systemPrompt: "You are a test agent.",
		source: "bundled",
		filePath: "/tmp/test.md",
	};

	assert(agent.name === "test-agent", "AgentConfig has name");
	assert(agent.source === "bundled", "AgentConfig has source");
	assert(agent.systemPrompt.length > 0, "AgentConfig has system prompt");
	assert(agent.filePath.length > 0, "AgentConfig has filePath");

	// Optional fields
	const fullAgent: AgentConfig = {
		...agent,
		tools: ["read", "grep"],
		model: "claude-haiku-4-5",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
		outputSchema: {
			type: "object",
			properties: { result: { type: "string" } },
			required: ["result"],
		},
	};

	assert(fullAgent.tools!.length === 2, "AgentConfig has tools");
	assert(fullAgent.model === "claude-haiku-4-5", "AgentConfig has model");
	assert(fullAgent.inputSchema !== undefined, "AgentConfig has inputSchema");
	assert(fullAgent.outputSchema !== undefined, "AgentConfig has outputSchema");
}

// ---------------------------------------------------------------------------
// Test: Agent schema validation integration
// ---------------------------------------------------------------------------
function testAgentSchemaValidation(): void {
	const agent: AgentConfig = {
		name: "scout",
		description: "Scout agent",
		systemPrompt: "You are a scout.",
		source: "bundled",
		filePath: "/tmp/scout.md",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
			},
			required: ["query"],
		},
		outputSchema: {
			type: "object",
			properties: {
				filesRetrieved: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
						},
						required: ["path"],
					},
				},
				architecture: { type: "string" },
			},
			required: ["filesRetrieved", "architecture"],
		},
	};

	// Test input schema validation
	const validInput = { query: "Find auth code" };
	const invalidInput = {};

	const validResult = validateSchema(validInput, agent.inputSchema!);
	assert(validResult.valid, "Valid input passes schema validation");

	const invalidResult = validateSchema(invalidInput, agent.inputSchema!);
	assert(!invalidResult.valid, "Missing required field fails schema validation");

	// Test output schema validation
	const validOutput = {
		filesRetrieved: [{ path: "src/auth.ts" }],
		architecture: "Auth flows through middleware",
	};
	const invalidOutput = {
		filesRetrieved: "not-an-array",
	};

	const validOutputResult = validateSchema(validOutput, agent.outputSchema!);
	assert(validOutputResult.valid, "Valid output passes schema validation");

	const invalidOutputResult = validateSchema(invalidOutput, agent.outputSchema!);
	assert(!invalidOutputResult.valid, "Type mismatch in output fails schema validation");
}

// ---------------------------------------------------------------------------
// Test: Input/output schema chaining
// ---------------------------------------------------------------------------
function testSchemaChaining(): void {
	// Simulate a chain: scout output → planner input
	const scoutOutputSchema = {
		type: "object",
		properties: {
			filesRetrieved: {
				type: "array",
				items: {
					type: "object",
					properties: { path: { type: "string" }, description: { type: "string" } },
					required: ["path"],
				},
			},
			architecture: { type: "string" },
		},
		required: ["filesRetrieved", "architecture"],
	};

	const plannerInputSchema = {
		type: "object",
		properties: {
			findings: {
				type: "object",
				properties: {
					filesRetrieved: { type: "array" },
					architecture: { type: "string" },
				},
			},
			requirements: { type: "string" },
		},
		required: ["findings", "requirements"],
	};

	// Scout output
	const scoutOutput = {
		filesRetrieved: [
			{ path: "src/auth.ts", description: "Auth middleware" },
		],
		architecture: "Middleware-based auth",
	};

	const scoutValid = validateSchema(scoutOutput, scoutOutputSchema);
	assert(scoutValid.valid, "Scout output is valid");

	// Pass scout output as planner input's "findings"
	const plannerInput = {
		findings: scoutOutput,
		requirements: "Add OAuth support",
	};

	const plannerValid = validateSchema(plannerInput, plannerInputSchema);
	assert(plannerValid.valid, "Planner input with scout's output is valid");

	// Missing requirements
	const invalidPlannerInput = { findings: scoutOutput };
	const plannerInvalid = validateSchema(invalidPlannerInput, plannerInputSchema);
	assert(
		!plannerInvalid.valid,
		"Planner input without requirements is invalid",
	);
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------
export function runAgentsTests(): void {
	console.log("\n📋 agents.ts tests");

	testAgentConfigShape();
	testAgentSchemaValidation();
	testSchemaChaining();

	console.log("  ✅ All agents.ts tests passed\n");
}