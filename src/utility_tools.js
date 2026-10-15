"use strict";

// Tools that aren't about files: dice and shuffling (real randomness, announced to everyone so
// games stay fair), a calculator (private, like thinking), and sealed envelopes (a secret the room
// keeps unchanged until its owner opens it, for games with hidden information).

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
		name: "shuffle",
		description: "Shuffle a list with real randomness, or draw some items from it without replacement: for a turn order, assigning roles, dealing, or picking several different options. Everyone in the room sees the list and the result.",
		input_schema: {
			type: "object",
			properties: {
				items: {type: "array", items: {type: "string"}, description: "The things to shuffle, 2 to 100 of them, e.g. [\"Opus\", \"Luna\", \"Sol\"]."},
				draw: {type: "integer", description: "Optional. How many to draw (keep only the first this many after shuffling). Default: all of them, in shuffled order."},
			},
			required: ["items"],
		},
	},
	{
		name: "calculate",
		description: `Evaluate an arithmetic expression the way a calculator would (double precision). The other models don't see the result. ${NAMES_HELP}`,
		input_schema: {
			type: "object",
			properties: {expression: {type: "string", description: "For example: 100000 / ln(10), or comb(52, 5)."}},
			required: ["expression"],
		},
	},
	{
		name: "seal_envelope",
		description: "Seal a secret in an envelope that the room keeps for you: a number to guess, a prediction, a hidden role. Everyone is told you sealed it, and its label, but not what's inside, and the room guarantees the contents can't change. Only you can open it, with open_envelope, which shows everyone what was inside. If you leave the room, your unopened envelopes are opened for everyone. Envelopes last for this session only.",
		input_schema: {
			type: "object",
			properties: {
				label: {type: "string", description: "A short public label, e.g. \"my number\". Everyone sees this."},
				content: {type: "string", description: "The secret. The other models don't see this until you open the envelope (the host's records do include it)."},
			},
			required: ["label", "content"],
		},
	},
	{
		name: "open_envelope",
		description: "Open one or more of your own sealed envelopes, showing everyone what's inside.",
		input_schema: {
			type: "object",
			properties: {numbers: {type: "array", items: {type: "integer"}, description: "The envelope numbers, given when you sealed them, e.g. [3] or [3, 5, 8]."}},
			required: ["numbers"],
		},
	},
];

// Tools with required fields use strict mode, so the API guarantees those fields are present.

for (let t of UTILITY_TOOLS) {
	if ((t.input_schema.required || []).length > 0) {
		t.strict = true;
		t.input_schema.additionalProperties = false;
	}
}

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

// The room's envelopes for one session. Contents are held here, not in any file, so nothing a
// model does can change them after sealing.

const ENVELOPE_LIMITS = {count: 50, label: 100, content: 2000};
const SHUFFLE_LIMITS = {items: 100, item_length: 200};

function new_envelopes() {
	return {

		list: [],

		seal: function(author, label, content) {
			if (typeof label !== "string" || !label.trim() || label.length > ENVELOPE_LIMITS.label) {
				throw new Error(`label must be text, 1 to ${ENVELOPE_LIMITS.label} characters.`);
			}
			if (typeof content !== "string" || !content.length || content.length > ENVELOPE_LIMITS.content) {
				throw new Error(`content must be text, 1 to ${ENVELOPE_LIMITS.content} characters.`);
			}
			if (this.list.length >= ENVELOPE_LIMITS.count) {
				throw new Error(`The room can hold at most ${ENVELOPE_LIMITS.count} envelopes in a session.`);
			}
			let envelope = {number: this.list.length + 1, author, label: label.trim().replace(/\s+/g, " "), content, opened: false};
			this.list.push(envelope);
			return envelope;
		},

		open: function(author, number) {
			if (!Number.isInteger(number)) {
				throw new Error("number must be a whole number.");
			}
			let envelope = this.list.find(e => e.number === number);
			if (!envelope) {
				throw new Error(`There's no envelope #${number}.`);
			}
			if (envelope.author !== author) {
				throw new Error(`Envelope #${number} is ${envelope.author}'s, and only they can open it.`);
			}
			if (envelope.opened) {
				throw new Error(`Envelope #${number} is already open.`);
			}
			envelope.opened = true;
			return envelope;
		},

		unopened: function(author = null) {
			return this.list.filter(e => !e.opened && (author === null || e.author === author));
		},
	};
}

function describe_opened(e) {
	return `envelope #${e.number} ("${e.label}"), which the room has kept unchanged since it was sealed. It contained: ${e.content}`;
}

// Returns {content, is_error, summary, announce}. announce is a notice for the other models.
// opts: {envelopes, random_int}. A function in place of opts is taken as random_int.

function run_utility_tool(tool_use, actor_name, opts = {}) {

	if (typeof opts === "function") {
		opts = {random_int: opts};
	}
	let random_int = opts.random_int || crypto.randomInt;
	let input = (tool_use.input && typeof tool_use.input === "object") ? tool_use.input : {};

	try {
		if (tool_use.name === "seal_envelope" || tool_use.name === "open_envelope") {
			if (!opts.envelopes) {
				throw new Error("There are no envelopes in this room.");
			}
			if (tool_use.name === "seal_envelope") {
				let e = opts.envelopes.seal(actor_name, input.label, input.content);
				return {
					content: `Sealed envelope #${e.number} ("${e.label}"). Everyone has been told it exists, but not what's inside. Open it with open_envelope, number ${e.number}.`,
					is_error: false,
					summary: `sealed envelope #${e.number} ("${e.label}")`,		// No contents here: the host may be playing too.
					announce: `${actor_name} sealed envelope #${e.number}: "${e.label}".`,
				};
			}
			// Several at once: each valid one opens, and any that can't be opened are reported.
			// (A lone "number" is accepted too, the tool's earlier form.)

			let numbers = Array.isArray(input.numbers) ? input.numbers : (input.number !== undefined ? [input.number] : []);
			if (numbers.length === 0) {
				throw new Error("numbers must list at least one envelope number, e.g. [3].");
			}
			if (numbers.length > ENVELOPE_LIMITS.count) {
				throw new Error(`numbers can list at most ${ENVELOPE_LIMITS.count} envelopes.`);
			}
			let opened = [];
			let problems = [];
			for (let n of [...new Set(numbers)]) {
				try {
					opened.push(opts.envelopes.open(actor_name, n));
				} catch (error) {
					problems.push(error.message);
				}
			}
			if (opened.length === 0) {
				throw new Error(problems.join(" "));
			}
			let lines = opened.map(describe_opened);
			let failed = problems.length > 0 ? ` Not opened: ${problems.join(" ")}` : "";
			return {
				content: `You opened ${lines.join("; and ")}. Everyone can see this.${failed}`,
				is_error: false,
				summary: `opened ${lines.join("; and ")}${failed ? ` (${failed.trim()})` : ""}`,
				announce: opened.length === 1 ? `${actor_name} opened ${lines[0]}` : `${actor_name} opened ${opened.length} envelopes: ${lines.join("; and ")}`,
			};
		}

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

		if (tool_use.name === "shuffle") {
			let items = input.items;
			if (!Array.isArray(items) || items.length < 2 || items.length > SHUFFLE_LIMITS.items) {
				throw new Error(`items must be a list of 2 to ${SHUFFLE_LIMITS.items} things.`);
			}
			if (items.some(x => typeof x !== "string" || !x.trim() || x.length > SHUFFLE_LIMITS.item_length)) {
				throw new Error(`each item must be text, 1 to ${SHUFFLE_LIMITS.item_length} characters.`);
			}
			items = items.map(x => x.trim().replace(/\s+/g, " "));
			let draw = whole_in_range(input.draw, items.length, 1, items.length, "draw");
			let order = items.slice();
			for (let i = order.length - 1; i > 0; i--) {			// Fisher-Yates.
				let j = random_int(0, i + 1);
				[order[i], order[j]] = [order[j], order[i]];
			}
			let result = order.slice(0, draw).join(", ");
			let what = draw === items.length
				? `shuffled ${items.length} items (${items.join(", ")}): ${result}`
				: `drew ${draw} of ${items.length} (${items.join(", ")}): ${result}`;
			return {
				content: `You ${what}. Everyone sees this result.`,
				is_error: false,
				summary: what,
				announce: `${actor_name} ${what}.`,
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

module.exports = {UTILITY_TOOLS, UTILITY_TOOL_NAMES, run_utility_tool, new_envelopes, describe_opened, ENVELOPE_LIMITS, SHUFFLE_LIMITS};
