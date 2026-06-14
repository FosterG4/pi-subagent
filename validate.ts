/**
 * Minimal JSON Schema validator for contract schemas.
 *
 * Validates structured data against inputSchema/outputSchema defined
 * in agent frontmatter. Supports: required fields, property types,
 * enums, nested objects, and arrays.
 *
 * No external dependencies — lightweight ~60 lines.
 */

export interface ValidationResult {
	valid: boolean;
	errors?: string[];
	data?: Record<string, unknown>;
}

/**
 * Validate a value against a JSON Schema-like object.
 */
export function validateSchema(
	data: unknown,
	schema: Record<string, unknown>,
): ValidationResult {
	const errors: string[] = [];

	if (typeof schema !== "object" || schema === null) {
		return { valid: true };
	}

	if (typeof data !== "object" || data === null) {
		errors.push("Expected an object, got " + typeof data);
		return { valid: false, errors };
	}

	const input = data as Record<string, unknown>;
	const schemaType = schema.type as string | undefined;

	// Basic type check
	if (schemaType && schemaType !== "object") {
		errors.push(`Expected schema type "object", got "${schemaType}"`);
		return { valid: false, errors };
	}

	const properties = schema.properties as Record<string, unknown> | undefined;
	const required = (schema.required as string[]) || [];
	const additionalProperties = schema.additionalProperties as boolean | undefined;

	// Check required fields
	for (const field of required) {
		if (!(field in input) || input[field] === undefined || input[field] === null) {
			errors.push(`Missing required field: "${field}"`);
		}
	}

	// Validate property types
	if (properties) {
		for (const [key, propSchema] of Object.entries(properties)) {
			if (!(key in input) || input[key] === undefined || input[key] === null) continue;

			const prop = propSchema as Record<string, unknown>;
			const value = input[key];
			const propType = prop.type as string | undefined;

			if (propType) {
				const typeError = validateType(value, propType, key);
				if (typeError) {
					errors.push(typeError);
					continue;
				}
			}

			// Enum validation
			const enumValues = prop.enum as unknown[] | undefined;
			if (enumValues && !enumValues.includes(value)) {
				errors.push(
					`Field "${key}": must be one of [${enumValues.map((e) => JSON.stringify(e)).join(", ")}], got ${JSON.stringify(value)}`,
				);
			}

			// Nested objects
			if (propType === "object" && prop.properties) {
				const nested = validateSchema(value, prop as Record<string, unknown>);
				if (!nested.valid && nested.errors) {
					errors.push(...nested.errors.map((e) => `${key}.${e}`));
				}
			}

			// Array items validation
			if (propType === "array" && prop.items) {
				if (!Array.isArray(value)) {
					errors.push(`Field "${key}": expected array, got ${typeof value}`);
				} else {
					const itemsSchema = prop.items as Record<string, unknown>;
					const itemType = itemsSchema.type as string | undefined;

					for (let i = 0; i < (value as unknown[]).length; i++) {
						const item = (value as unknown[])[i];
						if (itemType) {
							const itemError = validateType(item, itemType, `${key}[${i}]`);
							if (itemError) errors.push(itemError);
						}
						// Nested object items
						if (itemType === "object" && itemsSchema.properties) {
							const nested = validateSchema(
								item,
								itemsSchema as Record<string, unknown>,
							);
							if (!nested.valid && nested.errors) {
								errors.push(...nested.errors);
							}
						}
					}
				}
			}
		}
	}

	// Check for unexpected properties when additionalProperties is false
	if (additionalProperties === false && properties) {
		const allowedKeys = new Set(Object.keys(properties));
		for (const key of Object.keys(input)) {
			if (!allowedKeys.has(key)) {
				errors.push(`Unexpected field: "${key}"`);
			}
		}
	}

	if (errors.length > 0) {
		return { valid: false, errors };
	}

	return { valid: true, data: input };
}

function validateType(value: unknown, type: string, path: string): string | null {
	switch (type) {
		case "string":
			if (typeof value !== "string") {
				return `Field "${path}": expected string, got ${typeof value}`;
			}
			break;
		case "number":
			if (typeof value !== "number") {
				// Coerce string to number
				if (typeof value === "string" && !isNaN(Number(value))) {
					return null; // coercion allowed
				}
				return `Field "${path}": expected number, got ${typeof value}`;
			}
			break;
		case "boolean":
			if (typeof value !== "boolean") {
				return `Field "${path}": expected boolean, got ${typeof value}`;
			}
			break;
		case "array":
			if (!Array.isArray(value)) {
				return `Field "${path}": expected array, got ${typeof value}`;
			}
			break;
		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return `Field "${path}": expected object, got ${typeof value}`;
			}
			break;
	}
	return null;
}