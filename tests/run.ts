/**
 * @fosterg4/pi-subagent — Test runner
 *
 * Run all unit tests:
 *   npx tsx tests/run.ts
 */

import { runValidateTests } from "./validate.test.ts";
import { runAgentsTests } from "./agents.test.ts";
import { runUtilsTests } from "./utils.test.ts";

async function main() {
	console.log("🧪 @fosterg4/pi-subagent tests\n");
	console.log(`CWD: ${process.cwd()}`);

	let passed = 0;
	let failed = 0;

	interface TestSuite {
		name: string;
		fn: () => void | Promise<void>;
	}

	const testSuites: TestSuite[] = [
		{ name: "validate.ts", fn: runValidateTests },
		{ name: "agents.ts", fn: runAgentsTests },
		{ name: "utils.ts", fn: runUtilsTests },
	];

	for (const suite of testSuites) {
		try {
			await suite.fn();
			passed++;
		} catch (err) {
			console.error(`\n❌ ${suite.name} failed:`, (err as Error).message);
			failed++;
		}
	}

	console.log("━".repeat(40));
	console.log(`Results: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
	else console.log("🎉 All tests passed!");
}

main();