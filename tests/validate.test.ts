/**
 * Tests for validate.ts — JSON Schema validator
 */

import { validateSchema } from "../validate.ts";

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
// Test: Valid data passes
// ---------------------------------------------------------------------------
function testValidDataPasses(): void {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string" },
			age: { type: "number" },
		},
		required: ["name", "age"],
	};

	const result = validateSchema({ name: "Alice", age: 30 }, schema);
	assert(result.valid, "Valid data passes");
	assertEqual(result.data, { name: "Alice", age: 30 }, "Returns data on success");
}

// ---------------------------------------------------------------------------
// Test: Missing required field
// ---------------------------------------------------------------------------
function testMissingRequiredField(): void {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string" },
			age: { type: "number" },
		},
		required: ["name", "age"],
	};

	const result = validateSchema({ name: "Alice" }, schema);
	assert(!result.valid, "Missing required field fails");
	assert(result.errors!.length > 0, "Errors reported");
	assert(
		result.errors![0].includes("age"),
		'Error mentions missing field "age"',
	);
}

// ---------------------------------------------------------------------------
// Test: Type mismatch
// ---------------------------------------------------------------------------
function testTypeMismatch(): void {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string" },
			count: { type: "number" },
		},
		required: ["name"],
	};

	const result = validateSchema({ name: "test", count: "not-a-number" }, schema);
	assert(!result.valid, "Type mismatch fails");
	assert(
		result.errors![0].includes("count") && result.errors![0].includes("number"),
		"Error mentions field and expected type",
	);
}

// ---------------------------------------------------------------------------
// Test: Enum validation
// ---------------------------------------------------------------------------
function testEnumValidation(): void {
	const schema = {
		type: "object",
		properties: {
			level: {
				type: "string",
				enum: ["quick", "medium", "thorough"],
			},
		},
		required: ["level"],
	};

	const valid = validateSchema({ level: "medium" }, schema);
	assert(valid.valid, "Valid enum value passes");

	const invalid = validateSchema({ level: "slow" }, schema);
	assert(!invalid.valid, "Invalid enum value fails");
	assert(
		invalid.errors![0].includes("quick"),
		"Error shows valid enum options",
	);
}

// ---------------------------------------------------------------------------
// Test: Nested objects
// ---------------------------------------------------------------------------
function testNestedObjects(): void {
	const schema = {
		type: "object",
		properties: {
			metadata: {
				type: "object",
				properties: {
					created: { type: "string" },
					version: { type: "number" },
				},
				required: ["version"],
			},
		},
		required: ["metadata"],
	};

	const valid = validateSchema(
		{ metadata: { created: "today", version: 1 } },
		schema,
	);
	assert(valid.valid, "Valid nested object passes");

	const invalid = validateSchema({ metadata: { created: "today" } }, schema);
	assert(!invalid.valid, "Missing nested required field fails");
	assert(
		invalid.errors![0].includes("metadata"),
		"Error includes nested path",
	);
}

// ---------------------------------------------------------------------------
// Test: Array items
// ---------------------------------------------------------------------------
function testArrayItems(): void {
	const schema = {
		type: "object",
		properties: {
			files: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				},
			},
		},
		required: ["files"],
	};

	const valid = validateSchema(
		{ files: [{ path: "src/main.ts" }, { path: "src/utils.ts" }] },
		schema,
	);
	assert(valid.valid, "Valid array of objects passes");

	const invalid = validateSchema({ files: [{ path: "ok" }, {}] }, schema);
	assert(!invalid.valid, "Invalid array item fails");
}

// ---------------------------------------------------------------------------
// Test: No schema defined (backward compat)
// ---------------------------------------------------------------------------
function testNoSchema(): void {
	const result = validateSchema({ anything: "goes" }, {});
	assert(result.valid, "No schema returns valid");
}

// ---------------------------------------------------------------------------
// Test: Null/undefined data
// ---------------------------------------------------------------------------
function testNullData(): void {
	const schema = {
		type: "object",
		properties: { name: { type: "string" } },
	};

	const result = validateSchema(null, schema);
	assert(!result.valid, "Null data fails");
}

// ---------------------------------------------------------------------------
// Test: additionalProperties false
// ---------------------------------------------------------------------------
function testAdditionalPropertiesFalse(): void {
	const schema = {
		type: "object",
		properties: {
			name: { type: "string" },
		},
		additionalProperties: false,
	};

	const valid = validateSchema({ name: "Alice" }, schema);
	assert(valid.valid, "Allowed fields pass with additionalProperties=false");

	const invalid = validateSchema({ name: "Alice", extra: "field" }, schema);
	assert(!invalid.valid, "Unexpected fields fail with additionalProperties=false");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------
export function runValidateTests(): void {
	console.log("\n📋 validate.ts tests");

	testValidDataPasses();
	testMissingRequiredField();
	testTypeMismatch();
	testEnumValidation();
	testNestedObjects();
	testArrayItems();
	testNoSchema();
	testNullData();
	testAdditionalPropertiesFalse();

	console.log("  ✅ All validate.ts tests passed\n");
}