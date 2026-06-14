/**
 * Tests for utils.ts — shared formatting helpers (no pi runtime deps)
 */

import { fmt, usageLine, sumUsage } from "../utils.ts";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`❌ ${message}`);
	console.log(`  ✓ ${message}`);
	passed++;
}

function assertEq<T>(actual: T, expected: T, message: string): void {
	if (String(actual) !== String(expected)) {
		const msg = `❌ ${message}\n    Expected: ${JSON.stringify(expected)}\n    Actual:   ${JSON.stringify(actual)}`;
		throw new Error(msg);
	}
	console.log(`  ✓ ${message}`);
	passed++;
}

// ---------------------------------------------------------------------------
// fmt
// ---------------------------------------------------------------------------
function testFmtZero(): void {
	assertEq(fmt(0), "0", "fmt(0) → '0'");
}

function testFmtSmall(): void {
	assertEq(fmt(500), "500", "fmt(500) → '500'");
	assertEq(fmt(999), "999", "fmt(999) → '999'");
}

function testFmtKilo(): void {
	assertEq(fmt(1500), "1.5k", "fmt(1500) → '1.5k'");
	assertEq(fmt(12000), "12k", "fmt(12000) → '12k'");
	assertEq(fmt(9999), "10.0k", "fmt(9999) → '10.0k'");
}

function testFmtMillion(): void {
	assertEq(fmt(1500000), "1.5M", "fmt(1500000) → '1.5M'");
}

// ---------------------------------------------------------------------------
// usageLine
// ---------------------------------------------------------------------------
function testUsageLineBasic(): void {
	const u: UsageStats = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	assertEq(usageLine(u), "↑100 ↓50", "usageLine with input+output only");
}

function testUsageLineWithCache(): void {
	const u: UsageStats = { input: 200, output: 80, cacheRead: 300, cacheWrite: 10, cost: 0, contextTokens: 0, turns: 0 };
	const line = usageLine(u);
	assert(line.includes("↑200"), "usageLine shows input tokens");
	assert(line.includes("↓80"), "usageLine shows output tokens");
	assert(line.includes("R300"), "usageLine shows cache reads");
	assert(line.includes("CH60.0%"), "usageLine shows cache hit rate: CH60.0%");
}

function testUsageLineWithCost(): void {
	const u: UsageStats = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.015, contextTokens: 0, turns: 0 };
	assertEq(usageLine(u), "↑1.0k ↓500 $0.0150", "usageLine with cost");
}

function testUsageLineAllZero(): void {
	const u: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	assertEq(usageLine(u), "", "usageLine all zeros → empty string");
}

// ---------------------------------------------------------------------------
// sumUsage
// ---------------------------------------------------------------------------
function testSumUsageSingle(): void {
	const r1 = { usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, cost: 0.01, contextTokens: 0, turns: 0 } };
	const total = sumUsage([r1]);
	assert(total.input === 100, "sumUsage single: input matches");
	assert(total.output === 50, "sumUsage single: output matches");
	assert(total.cost === 0.01, "sumUsage single: cost matches");
}

function testSumUsageMultiple(): void {
	const r1 = { usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 0 } };
	const r2 = { usage: { input: 200, output: 100, cacheRead: 30, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 0 } };
	const total = sumUsage([r1, r2]);
	assertEq(total.input, 300, "sumUsage multiple: input = 300");
	assertEq(total.output, 150, "sumUsage multiple: output = 150");
	assertEq(total.cacheRead, 40, "sumUsage multiple: cacheRead = 40");
	assertEq(total.cost, 0.03, "sumUsage multiple: cost = 0.03");
}

function testSumUsageEmpty(): void {
	const total = sumUsage([]);
	assert(total.input === 0, "sumUsage empty: input = 0");
	assert(total.output === 0, "sumUsage empty: output = 0");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
export function runUtilsTests(): void {
	console.log("\n📋 utils.ts tests");

	testFmtZero();
	testFmtSmall();
	testFmtKilo();
	testFmtMillion();
	testUsageLineBasic();
	testUsageLineWithCache();
	testUsageLineWithCost();
	testUsageLineAllZero();
	testSumUsageSingle();
	testSumUsageMultiple();
	testSumUsageEmpty();

	console.log("  ✅ All utils.ts tests passed\n");
}
