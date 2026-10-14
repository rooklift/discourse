"use strict";

// The only file that talks to the Claude API. The room calls backend.send() and gets back
// the final message object; tests replace this with a fake backend of the same shape.

const sdk = require("@anthropic-ai/sdk");

// opts.on_warning(message) is told about anything the host should know, such as strict tool
// use being turned off.

function new_backend(api_key, opts = {}) {
	let backend = Object.create(backend_prototype);
	backend.client = new sdk.Anthropic({
		apiKey: api_key,
		maxRetries: opts.max_retries ?? 4,		// Retries connection errors, 408, 409, 429 and 5xx with backoff.
	});
	backend.on_warning = typeof opts.on_warning === "function" ? opts.on_warning : () => {};
	backend.strict_ok = true;				// Becomes false if the API ever rejects our strict tool schemas.
	return backend;
}

// A 400 that's about strict tool schemas (rather than, say, a malformed message).

function is_strict_schema_error(error) {
	return error instanceof sdk.BadRequestError && /strict|schema|grammar|compil/i.test(String(error.message));
}

function without_strict(tools) {
	return tools.map(t => {
		if (!t.strict) {
			return t;
		}
		let copy = Object.assign({}, t);
		delete copy.strict;
		return copy;
	});
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

		if (!this.strict_ok) {
			params.tools = without_strict(params.tools);
		}

		try {
			return await this.stream(params, req);
		} catch (error) {

			// Strict schemas are a safeguard, not a necessity: if the API won't accept them, carry
			// on without them for the rest of the session, rather than failing every turn.

			if (this.strict_ok && params.tools.some(t => t.strict) && is_strict_schema_error(error)) {
				this.strict_ok = false;
				this.on_warning(`The API rejected the strict tool schemas, so they're off for this session (tools still work, with the room's own checks). The API said: ${error.message}`);
				return await this.stream(Object.assign({}, params, {tools: without_strict(params.tools)}), req);
			}
			throw error;
		}
	},

	stream: async function(params, req) {
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
