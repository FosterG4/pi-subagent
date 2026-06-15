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

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
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
	private cachedWidth?: number;
	private cachedLines?: string[];

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
		entry.elapsedMs = Date.now() - (this.startTimes.get(name) ?? Date.now());
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

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		if (this.entries.length === 0) {
			this.cachedWidth = width;
			this.cachedLines = [];
			return [];
		}

		// Header
		lines.push("● Agents");

		for (const entry of this.entries) {
			const icon = statusIcon(entry.status, this.frame);
			const parts: string[] = [];

			// Turns
			if (entry.turns > 0) parts.push(`↻${entry.turns}`);

			// Tokens
			if (entry.tokens > 0) {
				const tokStr = fmt(entry.tokens);
				parts.push(`${tokStr} token`);
				if (entry.contextUsagePct !== undefined && entry.contextUsagePct > 0) {
					parts.push(`(${entry.contextUsagePct}%)`);
				}
			}

			// Time
			if (entry.elapsedMs > 0) parts.push(formatTime(entry.elapsedMs));

			// Model
			if (entry.model) parts.push(entry.model);

			const stats = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";

			let line = ` ${icon} ${entry.name}${stats}`;
			if (line.length > width) {
				line = line.slice(0, width - 1) + "…";
			}
			lines.push(line);

			// Activity sub-line
			if (entry.task && entry.status === "running") {
				const preview =
					entry.task.length > 60
						? `${entry.task.slice(0, 57)}…`
						: entry.task;
				lines.push(`  ⎿  ${preview}`);
			}
		}

		this.frame++;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}