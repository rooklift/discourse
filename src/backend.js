"use strict";

// The only file that talks to the Claude API. The room calls backend.send() and gets back
// the final message object; tests replace this with a fake backend of the same shape.

const sdk = require("@anthropic-ai/sdk");

function new_backend(api_key, opts = {}) {
	let backend = Object.create(backend_prototype);
	backend.client = new sdk.Anthropic({
		apiKey: api_key,
		maxRetries: opts.max_retries ?? 4,		// Retries connection errors, 408, 409, 429 and 5xx with backoff.
	});
	return backend;
}

const backend_prototype = {

	// req: {participant, system, messages, tools, show_thinking, cache_ttl, signal, on_text}
	// Resolves to the API's final message object: {content, stop_reason, usage, ...}

	send: async function(req) {

		let p = req.participant;

		let params = {
			model: p.model,
			max_tokens: p.max_tokens,
			system: req.system,
			messages: req.messages,
			tools: req.tools,
			cache_control: req.cache_ttl === "1h" ? {type: "ephemeral", ttl: "1h"} : {type: "ephemeral"},
		};

		if (p.effort) {
			params.output_config = {effort: p.effort};
		}

		// Thinking is on by default for current models, with its text omitted. Only ask for
		// summaries when the host wants to see them. Either way, thinking blocks come back
		// with signatures and the room passes them back unchanged.

		if (req.show_thinking) {
			params.thinking = {type: "adaptive", display: "summarized"};
		}

		let stream = this.client.messages.stream(params, {signal: req.signal});

		if (typeof req.on_text === "function") {
			stream.on("text", (delta) => req.on_text(delta));
		}

		return await stream.finalMessage();
	},

	is_abort_error: function(error) {
		return error instanceof sdk.APIUserAbortError || error?.name === "AbortError";
	},
};

module.exports = {new_backend};
