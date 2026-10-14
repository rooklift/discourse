"use strict";

// Tools that aren't about files: dice (real randomness, announced to everyone so games stay
// fair), a calculator (private, like thinking), and sealed envelopes (a secret the room keeps
// unchanged until its owner opens it, for games with hidden information).

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
		description: `Evaluate an arithmetic expression the way a calculator would (double precision). The result is private to you. ${NAMES_HELP}`,
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
				content: {type: "string", description: "The secret. Nobody sees this until you open the envelope."},
			},
			required: ["label", "content"],
		},
	},
	{
		name: "open_envelope",
		description: "Open one of your own sealed envelopes, showing everyone what's inside.",
		input_schema: {
			type: "object",
			properties: {number: {type: "integer", description: "The envelope's number, given when you sealed it."}},
			required: ["number"],
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

// The room's envelopes for one session. Contents are held here, not in any file, so nothing a
// model does can change them after sealing.

const ENVELOPE_LIMITS = {count: 50, label: 100, content: 2000};

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
			let e = opts.envelopes.open(actor_name, input.number);
			return {
				content: `You opened ${describe_opened(e)}. Everyone can see this.`,
				is_error: false,
				summary: `opened ${describe_opened(e)}`,
				announce: `${actor_name} opened ${describe_opened(e)}`,
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

module.exports = {UTILITY_TOOLS, UTILITY_TOOL_NAMES, run_utility_tool, new_envelopes, describe_opened, ENVELOPE_LIMITS};
