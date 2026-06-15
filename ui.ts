/**
 * Claude Code-style live progress widget for subagent execution.
 *
 * Renders a compact overlay showing spinner + agent name + stats.
 * Designed to be used with pi's ctx.ui.custom(…) overlay system.
 *
 * Usage:
 *   const widget = new AgentWidget();
 *   widget.addAgent("scout", "Find auth files");
 *   const handle = ctx.ui.custom(widget, { overlay: true });
 *   widget.updateAgent("scout", { turns: 3, tokens: 12400, elapsedMs: 4100 });
 *   handle.close();
 */

import { fmt } from "./utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatus = "running" | "done" | "error";

export interface WidgetEntry {
	name: string;
	task: string;
	status: AgentStatus;
	turns: number;
	tokens: number;
	contextUsagePct?: number;
	elapsedMs: number;
	model?: string;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ms: number): string {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.round(s)}s`;
	const m = Math.floor(s / 60);
	const sec = Math.round(s % 60);
	return `${m}m${sec}s`;
}

function statusIcon(status: AgentStatus, frame: number): string {
	switch (status) {
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "running":
		default:
			return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
	}
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export class AgentWidget {
	private entries: WidgetEntry[] = [];
	private frame = 0;
	private startTimes: Map<string, number> = new Map();

	addAgent(name: string, task: string): void {
		const exists = this.entries.find((e) => e.name === name);
		if (exists) return;
		this.entries.push({
			name,
			task,
			status: "running",
			turns: 0,
			tokens: 0,
			elapsedMs: 0,
		});
		this.startTimes.set(name, Date.now());
		this.invalidate();
	}

	updateAgent(name: string, update: Partial<WidgetEntry>): void {
		const entry = this.entries.find((e) => e.name === name);
		if (!entry) return;
		Object.assign(entry, update);
		this.invalidate();
	}

	removeAgent(name: string): void {
		this.entries = this.entries.filter((e) => e.name !== name);
		this.startTimes.delete(name);
		this.invalidate();
	}

	getAgent(name: string): WidgetEntry | undefined {
		return this.entries.find((e) => e.name === name);
	}

	markDone(name: string): void {
		const entry = this.entries.find((e) => e.name === name);
		if (entry) { entry.status = "done"; }
		this.invalidate();
	}

	invalidate(): void {
		// No cache to invalidate — render() is always fresh
	}

	private entryLine(entry: WidgetEntry, width: number): string[] {
		const lines: string[] = [];
		const now = Date.now();
		const elapsedMs = entry.elapsedMs || (now - (this.startTimes.get(entry.name) ?? now));

		const icon = statusIcon(entry.status, this.frame);
		const parts: string[] = [];

		// Always show icon + name
		let line = `\u00A0${icon} ${entry.name}`;

		// Turns
		parts.push(entry.turns > 0 ? `↻${entry.turns}` : "↻0");

		// Tokens
		if (entry.tokens > 0) {
			const tokStr = fmt(entry.tokens);
			parts.push(`${tokStr} token`);
			if (entry.contextUsagePct !== undefined && entry.contextUsagePct > 0) {
				parts.push(`(${entry.contextUsagePct}%)`);
			}
		}

		// Time
		if (elapsedMs > 99) parts.push(formatTime(elapsedMs));
		else parts.push("0.0s");

		// Model
		if (entry.model) parts.push(entry.model);

		line += ` · ${parts.join(" · ")}`;
		if (line.length > width) line = line.slice(0, width - 3) + "…";
		lines.push(line);

		// Activity sub-line (running agents only)
		if (entry.task && entry.status === "running") {
			const preview = entry.task.length > 60 ? `${entry.task.slice(0, 57)}…` : entry.task;
			lines.push(`  ⎿  ${preview}`);
		}

		return lines;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.entries.length === 0) return [];

		// Header
		lines.push("\u25CF Agents");

		for (const entry of this.entries) {
			lines.push(...this.entryLine(entry, width));
		}

		this.frame++;
		return lines;
	}
}