/**
 * @fosterg4/pi-subagent - Delegate tasks to specialized subagents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Extends the reference implementation with:
 *   - Bundled agent discovery (agents ship with the package)
 *   - Contract schemas (inputSchema/outputSchema with structured JSON handoff)
 *   - Live per-subagent TUI tool call streaming
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentList,
} from "./agents.ts";
import { type ValidationResult, validateSchema } from "./validate.ts";
import { fmt, usageLine, sumUsage } from "./utils.ts";
import { AgentWidget, type WidgetEntry } from "./ui.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/* eslint-disable @typescript-eslint/no-unused-vars */

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	structuredOutput?: Record<string, unknown>;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Temp prompt file
// ---------------------------------------------------------------------------

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

// ---------------------------------------------------------------------------
// Pi invocation helper
// ---------------------------------------------------------------------------

function getPiInvocation(
	args: string[],
): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Extract structured JSON from assistant output
// ---------------------------------------------------------------------------

function extractStructuredOutput(
	messages: Message[],
): Record<string, unknown> | undefined {
	const finalOutput = getFinalOutput(messages);
	if (!finalOutput) return undefined;

	// Try to parse the entire output as JSON
	try {
		return JSON.parse(finalOutput) as Record<string, unknown>;
	} catch {
		// Not valid JSON — look for a JSON code block
		const jsonMatch = finalOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
		if (jsonMatch) {
			try {
				return JSON.parse(jsonMatch[1]) as Record<string, unknown>;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Run single agent
// ---------------------------------------------------------------------------

type OnUpdateCallback = (partial: {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
}) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onStats?: (stats: { turns: number; tokens: number }) => void,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available =
			agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	// Validate task against agent's inputSchema if present
	if (agent.inputSchema) {
		const taskInput = parseStructuredTask(task);
		const validation = validateSchema(taskInput, agent.inputSchema);
		if (!validation.valid) {
			return {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: `Input validation failed for agent "${agentName}":\n${(validation.errors ?? []).join("\n")}\n\nExpected schema: ${JSON.stringify(agent.inputSchema, null, 2)}`,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
				step,
			};
		}
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						const total = currentResult.usage.input + currentResult.usage.output + currentResult.usage.cacheRead;
						onStats?.({ turns: currentResult.usage.turns, tokens: total });
						if (!currentResult.model && msg.model)
							currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				let wasAborted = false;
				const killProc = () => {
					if (wasAborted) return;
					wasAborted = true;
					currentResult.stopReason = "aborted";
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;

		// Extract structured output from final messages
		if (agent.outputSchema) {
			currentResult.structuredOutput = extractStructuredOutput(
				currentResult.messages,
			);

			// Validate structured output against outputSchema
			if (currentResult.structuredOutput) {
				const validation = validateSchema(
					currentResult.structuredOutput,
					agent.outputSchema,
				);
				if (!validation.valid) {
					currentResult.stderr += `\n[Output schema validation warning: ${(validation.errors ?? []).join("; ")}]`;
				}
			}
		}

		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ---------------------------------------------------------------------------
// Parse structured task from text
// ---------------------------------------------------------------------------

function parseStructuredTask(task: string): Record<string, unknown> {
	try {
		return JSON.parse(task) as Record<string, unknown>;
	} catch {
		return { query: task };
	}
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description:
			"Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" }),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description:
				"Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(
			_toolCallId,
			params,
			signal,
			onUpdate,
			ctx,
		) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount =
				Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const formatted = formatAgentList(agents, 10);
				const available = formatted.text || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one of: agent+task, tasks[], or chain[].\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Confirm project agents
			if (
				(agentScope === "project" || agentScope === "both") &&
				params.confirmProjectAgents !== false &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain)
					for (const step of params.chain)
						requestedAgentNames.add(step.agent);
				if (params.tasks)
					for (const t of params.tasks)
						requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter(
						(a): a is AgentConfig =>
							a?.source === "project",
					);

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested
						.map((a) => a.name)
						.join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(
								hasChain ? "chain" : hasTasks ? "parallel" : "single",
							)([]),
						};
				}
			}

			// ---- Chain mode ----
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousStructured: Record<string, unknown> | undefined;
				let widgetHandle: ReturnType<typeof pi.ui.custom> | undefined;

				const closeWidget = () => {
					if (widgetTimer) { clearInterval(widgetTimer); widgetTimer = undefined; }
					if (widgetHandle) {
						widgetHandle.close();
						widgetHandle = undefined;
					}
					widgetRef = undefined;
				};

				for (let i = 0; i < params.chain.length; i++) {
					closeWidget();

					const step = params.chain[i];
					let taskWithContext = step.task;

					// Replace {previous} with structured output from prior step
					if (previousStructured) {
						taskWithContext = taskWithContext.replace(
							/\{previous\}/g,
							JSON.stringify(previousStructured, null, 2),
						);
					} else if (i > 0) {
						taskWithContext = taskWithContext.replace(
							/\{previous\}/g,
							getFinalOutput(results[i - 1]?.messages ?? ""),
						);
					}

					// Spawn live widget for this step
					let widgetRef: AgentWidget | undefined;
					let widgetTimer: ReturnType<typeof setInterval> | undefined;
					if (ctx.hasUI) {
						widgetRef = new AgentWidget();
						widgetRef.addAgent(step.agent, step.task.replace(/\{[^}]+\}/g, "").trim());
						widgetHandle = ctx.ui.custom(
							(_tui, _theme, _kb, done) => {
								widgetTimer = setInterval(() => widgetRef?.invalidate(), 200);
								return widgetRef!;
							},
							{ overlay: true },
						);
					}

					const stepStats = (stats: { turns: number; tokens: number }) => {
						widgetRef?.invalidate();
					};

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						stepStats,
					);
					results.push(result);

					// Check if next agent in chain expects structured input
					const nextAgent = params.chain[i + 1];
					if (
						nextAgent &&
						result.structuredOutput &&
						!isFailedResult(result)
					) {
						previousStructured = result.structuredOutput;
					} else {
						previousStructured = undefined;
					}

					if (isFailedResult(result)) {
						closeWidget();
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
				}

				closeWidget();

				const lastResult = results[results.length - 1];
				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(lastResult.messages) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			// ---- Parallel mode ----
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);

				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter(
					(r) => !isFailedResult(r),
				).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// ---- Single mode ----
			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const formatted = formatAgentList(agents, 10);
			const available = formatted.text || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		// -----------------------------------------------------------------------
		// TUI rendering
		// -----------------------------------------------------------------------

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40
							? `${cleanTask.slice(0, 40)}...`
							: cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			const getFinalOutputText = (messages: Message[]): string => {
				const text = getFinalOutput(messages);
				// Try to extract clean text from JSON output (remove wrapper text)
				const extracted = extractStructuredOutput(messages);
				if (extracted) return JSON.stringify(extracted, null, 2);
				return text;
			};

			const getStatusText = (r: SingleResult): string => {
				if (r.exitCode === 0) return theme.fg("success", "\u2713");
				if (r.exitCode === -1) return theme.fg("warning", "\u23F3");
				return theme.fg("error", "\u2717");
			};

		// --- Single mode ---
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const status = getStatusText(r);
				const finalOutput = getFinalOutputText(r.messages);
				const usage = usageLine(r.usage);
				const usg = usage ? theme.fg("dim", usage) : "";

				if (expanded) {
					const container = new Container();
					const header = `${status} ${theme.fg("accent", r.agent)}${theme.fg("muted", r.model ? ` \u00B7 ${r.model}` : "")}`;
					container.addChild(new Text(header, 0, 0));
					if (r.stderr) container.addChild(new Text(theme.fg("error", r.stderr), 0, 0));
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
					if (usg) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(usg, 0, 0));
					}
					return container;
				}

				let text = `${status} ${theme.fg("accent", r.agent)}`;
				if (finalOutput) {
					const preview = finalOutput.split("\n").slice(0, 5).join("\n");
					const truncated = finalOutput.split("\n").length > 5;
					text += `\n${theme.fg("toolOutput", preview)}`;
					if (truncated) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				} else {
					text += `\n${theme.fg("muted", "(no output)")}`;
				}
				if (usg) text += `\n${usg}`;
				return new Text(text, 0, 0);
			}

			// --- Chain mode ---
			if (details.mode === "chain") {
				const lastResult = details.results[details.results.length - 1];
				const finalOutput = lastResult ? getFinalOutputText(lastResult.messages) : "";
				const allOk = details.results.every((r) => r.exitCode === 0);
				const icon = allOk ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
				const steps = details.results.map((r) => r.agent).join(" \u2192 ");
				const total = sumUsage(details.results);
				const totalUsg = usageLine(total);

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(`${icon} ${theme.fg("accent", steps)}`, 0, 0),
					);
					for (const r of details.results) {
						const out = getFinalOutputText(r.messages);
						const stepUsage = usageLine(r.usage);
						const stepUsg = stepUsage ? theme.fg("dim", stepUsage) : "";
						const label = `${getStatusText(r)} ${theme.fg("accent", r.agent)}${r.model ? theme.fg("muted", ` \u00B7 ${r.model}`) : ""}${stepUsg ? "  " + stepUsg : ""}`;
						if (out) {
							container.addChild(new Spacer(1));
							container.addChild(new Text(label, 0, 0));
							container.addChild(new Markdown(out.trim(), 0, 0, mdTheme));
						}
					}
					if (totalUsg && details.results.length > 1) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(totalUsg, 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("accent", steps)}`;
				if (finalOutput) {
					const preview = finalOutput.split("\n").slice(0, 5).join("\n");
					const truncated = finalOutput.split("\n").length > 5;
					text += `\n${theme.fg("toolOutput", preview)}`;
					if (truncated) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				} else {
					text += `\n${theme.fg("muted", "(no output)")}`;
				}
				if (totalUsg) text += `\n${totalUsg}`;
				return new Text(text, 0, 0);
			}

			// --- Parallel mode ---
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const done = details.results.filter((r) => r.exitCode !== -1).length;
				const allOk = details.results.every((r) => r.exitCode === 0);
				const icon = running > 0
					? theme.fg("warning", "\u23F3")
					: allOk
						? theme.fg("success", "\u2713")
						: theme.fg("error", "\u2717");

				if (expanded && running === 0) {
					const container = new Container();
					const total = sumUsage(details.results);
					const totalUsg = usageLine(total);
					container.addChild(
						new Text(
							`${icon} ${theme.fg("accent", `${done} tasks`)}`,
							0,
							0,
						),
					);
					for (const r of details.results) {
						const out = getFinalOutputText(r.messages);
						const stepUsage = usageLine(r.usage);
						const stepUsg = stepUsage ? theme.fg("dim", stepUsage) : "";
						if (out) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Text(
									`${getStatusText(r)} ${theme.fg("accent", r.agent)}${stepUsg ? "  " + stepUsg : ""}`,
									0,
									0,
								),
							);
							container.addChild(new Markdown(out.trim(), 0, 0, mdTheme));
						}
					}
					if (totalUsg && details.results.length > 1) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(totalUsg, 0, 0));
					}
					return container;
				}

				const usg = usageLine(sumUsage(details.results));
				let text = `${icon} ${theme.fg("accent", `${done}/${details.results.length} tasks`)}`;
				if (running === 0) {
					if (usg) text += `\n${usg}`;
					if (!expanded) text += theme.fg("muted", " (Ctrl+O to expand)");
				}
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(
				text?.type === "text" ? text.text : "(no output)",
				0,
				0,
			);
		},
	});
}