/**
 * Shared formatting helpers — testable without pi runtime deps
 */

import type { UsageStats } from "./index.ts";

export function fmt(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return (n / 1000).toFixed(1) + "k";
	if (n < 1000000) return Math.round(n / 1000) + "k";
	return (n / 1000000).toFixed(1) + "M";
}

export function usageLine(u: UsageStats): string {
	const parts: string[] = [];
	if (u.input) parts.push("\u2191" + fmt(u.input));
	if (u.output) parts.push("\u2193" + fmt(u.output));
	if (u.cacheRead) {
		parts.push("R" + fmt(u.cacheRead));
		const total = u.input + u.cacheRead;
		if (total > 0) parts.push("CH" + ((u.cacheRead / total) * 100).toFixed(1) + "%");
	}
	if (u.cost) parts.push("$" + u.cost.toFixed(4));
	return parts.join(" ");
}

export function sumUsage(results: ReadonlyArray<{ usage: UsageStats }>): UsageStats {
	const u: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const r of results) {
		u.input += r.usage.input;
		u.output += r.usage.output;
		u.cacheRead += r.usage.cacheRead;
		u.cacheWrite += r.usage.cacheWrite;
		u.cost += r.usage.cost;
	}
	return u;
}
