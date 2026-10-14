"use strict";

// Prices in dollars per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// (checked October 2026). A participant can override these with a "prices" object in config.json.
//
// Each entry is a list of tiers. A request uses the first tier whose up_to is at least the
// request's total prompt length (uncached input + cache reads + cache writes).

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
};

const PRICE_FIELDS = ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"];

function tiers_for(model, override) {
	if (override) {
		for (let field of PRICE_FIELDS) {
			if (typeof override[field] !== "number") {
				throw new Error(`prices for ${model} must include a number for "${field}"`);
			}
		}
		return [Object.assign({up_to: Infinity}, override)];
	}
	return PRICES[model] || null;
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
