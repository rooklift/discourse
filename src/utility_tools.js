"use strict";

// Tools that aren't about files: dice (real randomness, announced to everyone so games stay
// fair) and a calculator (private, like thinking).

const crypto = require("crypto");
const {calculate, NAMES_HELP} = require("./calc");

const UTILITY_TOOLS = [
	{
		name: "roll_dice",
		description: "Roll dice with real randomness. Everyone in the room sees the result. Use sides 2 for a coin, or sides N to pick one of N options.",
		input_schema: {
			type: "object",
			properties: {
				sides: {type: "integer", description: "Sides per die, 2 to 1000. Default 6."},
				count: {type: "integer", description: "How many dice, 1 to 100. Default 1."},
			},
		},
	},
	{
		name: "calculate",
		description: `Evaluate an arithmetic expression exactly as a calculator would (double precision). The result is private to you. ${NAMES_HELP}`,
		input_schema: {
			type: "object",
			properties: {expression: {type: "string", description: "For example: 100000 / ln(10), or comb(52, 5)."}},
			required: ["expression"],
		},
	},
];

const UTILITY_TOOL_NAMES = UTILITY_TOOLS.map(t => t.name);

function whole_in_range(value, fallback, min, max, label) {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
	}
	return value;
}

// Returns {content, is_error, summary, announce}. announce is a notice for the other models.

function run_utility_tool(tool_use, actor_name, random_int = crypto.randomInt) {

	let input = (tool_use.input && typeof tool_use.input === "object") ? tool_use.input : {};

	try {
		if (tool_use.name === "roll_dice") {
			let sides = whole_in_range(input.sides, 6, 2, 1000, "sides");
			let count = whole_in_range(input.count, 1, 1, 100, "count");
			let rolls = [];
			for (let i = 0; i < count; i++) {
				rolls.push(random_int(1, sides + 1));
			}
			let dice = count === 1 ? `a d${sides}` : `${count}d${sides}`;
			let shown = count === 1 ? String(rolls[0]) : `${rolls.join(", ")} (total ${rolls.reduce((a, b) => a + b, 0)})`;
			return {
				content: `You rolled ${dice}: ${shown}. Everyone sees this result.`,
				is_error: false,
				summary: `rolled ${dice}: ${shown}`,
				announce: `${actor_name} rolled ${dice}: ${shown}.`,
			};
		}

		if (tool_use.name === "calculate") {
			let result = calculate(input.expression);
			let expr = input.expression.length > 80 ? input.expression.slice(0, 80) + "..." : input.expression;
			return {content: `${input.expression} = ${result}`, is_error: false, summary: `calculated ${expr} = ${result}`, announce: ""};
		}
	} catch (error) {
		let message = typeof error?.message === "string" ? error.message : "something went wrong.";
		return {content: `Error: ${message}`, is_error: true, summary: `tried ${tool_use.name}, error: ${message}`, announce: ""};
	}

	return {content: `Unknown tool: ${tool_use.name}`, is_error: true, summary: "unknown tool", announce: ""};
}

module.exports = {UTILITY_TOOLS, UTILITY_TOOL_NAMES, run_utility_tool};
