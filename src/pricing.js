"use strict";

// Prices in dollars per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// https://ai.google.dev/gemini-api/docs/pricing and https://developers.openai.com/api/docs/pricing
// (all checked October 2026; Gemini and OpenAI prices are the standard tier). A participant can override these with a "prices" object in config.json.
//
// Each entry is a list of tiers. A request uses the first tier whose up_to is at least the
// request's total prompt length (uncached input + cache reads + cache writes).
//
// Some Gemini prices are already scheduled to rise, so those entries are a list of periods
// instead, each with the date it ends ("until", exclusive) and its tiers.

const PRICES = {
	"claude-fable-5-1": [
		{up_to: Infinity, input: 10, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 0.25, output: 50},
	],
	"claude-opus-5-5": [
		{up_to: Infinity, input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.20, output: 20},
	],
	"claude-sonnet-5-5": [
		{up_to: Infinity, input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.10, output: 10},
	],
	"claude-haiku-5-5": [
		{up_to: 100000, input: 0.10, cache_write_5m: 0.125, cache_write_1h: 0.20, cache_read: 0.01, output: 0.50},
		{up_to: Infinity, input: 0.50, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.50},
	],

	// Gemini caching is implicit: there's no charge for writing to the cache, only a lower price
	// for reading from it. (Explicit caching, which bills storage, isn't used.)

	"gemini-4-argon": [
		{until: "2026-12-01", tiers: [gemini(2, 10, 0.10)]},
		{tiers: [gemini(4, 20, 0.20)]},
	],
	"gemini-3.8-flash": [
		{until: "2027-01-01", tiers: [gemini(0.75, 3.75, 0.075)]},
		{tiers: [gemini(1.50, 7.50, 0.15)]},
	],
	"gemini-3.6-flash": [
		{until: "2027-01-01", tiers: [gemini(0.75, 3.75, 0.075)]},
		{tiers: [gemini(1.50, 7.50, 0.15)]},
	],
	"gemini-3.5-flash-lite": [gemini(0.30, 2.50, 0.03)],
	"gemini-3.1-flash-lite": [gemini(0.25, 1.50, 0.025)],
	"gemini-3.1-pro-preview": [gemini(2, 12, 0.20, 200000), gemini(4, 18, 0.40)],
	"gemini-2.5-pro": [gemini(1.25, 10, 0.125, 200000), gemini(2.50, 15, 0.25)],
	"gemini-2.5-flash": [gemini(0.30, 2.50, 0.03)],

	// OpenAI charges for cache writes too (1.25x input), and above 272K prompt tokens the whole
	// request is priced at 2x input and cache rates and 1.5x output.

	"gpt-6-astra": [openai(10, 1, 12.5, 50, 272000), openai(20, 2, 25, 75)],
	"gpt-6.1-sol": [openai(2, 0.10, 2.5, 10, 272000), openai(4, 0.20, 5, 15)],
	"gpt-6-luna": [openai(0.10, 0.01, 0.125, 0.50, 272000), openai(0.20, 0.02, 0.25, 0.75)],
};

function gemini(input, output, cache_read, up_to = Infinity) {
	return {up_to, input, cache_write_5m: input, cache_write_1h: input, cache_read, output};
}

function openai(input, cache_read, cache_write, output, up_to = Infinity) {
	return {up_to, input, cache_write_5m: cache_write, cache_write_1h: cache_write, cache_read, output};
}

const PRICE_FIELDS = ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"];

// now: when the session runs, for prices that change on a set date.

function tiers_for(model, override, now = new Date()) {
	if (override) {
		for (let field of PRICE_FIELDS) {
			if (typeof override[field] !== "number") {
				throw new Error(`prices for ${model} must include a number for "${field}"`);
			}
		}
		return [Object.assign({up_to: Infinity}, override)];
	}
	let entry = PRICES[model];
	if (!entry) {
		return null;
	}
	if (entry[0].tiers) {
		let today = now.toISOString().slice(0, 10);
		return (entry.find(period => !period.until || today < period.until) || entry[entry.length - 1]).tiers;
	}
	return entry;
}

// Returns the cost in dollars of one response, given its usage object, or null if unknown.

function cost_of_usage(tiers, usage, cache_ttl) {
	if (!tiers) {
		return null;
	}

	let uncached = usage.input_tokens || 0;
	let read = usage.cache_read_input_tokens || 0;
	let written = usage.cache_creation_input_tokens || 0;
	let output = usage.output_tokens || 0;

	// Prefer the API's breakdown of cache writes by TTL; otherwise assume the configured TTL.

	let written_5m = cache_ttl === "1h" ? 0 : written;
	let written_1h = cache_ttl === "1h" ? written : 0;
	if (usage.cache_creation) {
		written_5m = usage.cache_creation.ephemeral_5m_input_tokens || 0;
		written_1h = usage.cache_creation.ephemeral_1h_input_tokens || 0;
	}

	let prompt_length = uncached + read + written;
	let tier = tiers.find(t => prompt_length <= t.up_to) || tiers[tiers.length - 1];

	let dollars =
		uncached * tier.input +
		read * tier.cache_read +
		written_5m * tier.cache_write_5m +
		written_1h * tier.cache_write_1h +
		output * tier.output;

	return dollars / 1000000;
}

module.exports = {tiers_for, cost_of_usage};
