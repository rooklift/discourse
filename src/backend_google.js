"use strict";

// Talks to Google's Gemini models through the Interactions API
// (https://ai.google.dev/gemini-api/docs/interactions-overview).
//
// The room speaks the Messages API's shapes: it builds Anthropic-style messages and expects an
// Anthropic-style message back. This backend translates both ways, so the room doesn't need to
// know which company made a participant.
//
// It's stateless, like the Claude side: every request carries that model's whole view of the
// conversation, and nothing is stored at Google ("store": false). The room keeps the history.
//
// Gemini's reasoning comes back as "thought" steps with opaque signatures, and Google requires
// them (and the steps around them) to be sent back exactly as received. So each block this
// backend returns carries the step it came from as "native", and on the way back any block
// with a "native" step is sent as that step, untouched.
//
// It uses fetch directly (src/http.js) rather than Google's SDK: the API is one JSON POST, and
// the SDK brings auth libraries, protobufs and websockets along with it.

const {new_poster, APIError, is_abort_error, system_text, tool_result_text} = require("./http");

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

// opts: {max_retries, on_warning, fetch, sleep, endpoint}. fetch and sleep are for tests.

function new_google_backend(api_key, opts = {}) {
	let backend = Object.create(google_prototype);
	backend.on_warning = typeof opts.on_warning === "function" ? opts.on_warning : () => {};
	backend.post = new_poster({
		api_name: "Gemini",
		url: opts.endpoint || ENDPOINT,
		headers: {"x-goog-api-key": api_key},
		max_retries: opts.max_retries,
		fetch: opts.fetch,
		sleep: opts.sleep,
	});
	backend.validated_ok = true;			// Becomes false if the API ever rejects tool_choice "validated".
	return backend;
}

const google_prototype = {

	// req: {participant, system, messages, tools, show_thinking, cache_ttl, signal, on_text}
	// Resolves to an Anthropic-shaped message: {content, stop_reason, usage}.

	send: async function(req) {

		let body = this.build_body(req);

		let interaction;
		try {
			interaction = await this.post(body, req.signal);
		} catch (error) {

			// Schema-checked tool calls are a safeguard, as strict tools are on the Claude side:
			// if the API won't accept them, carry on without them rather than failing every turn.

			if (body.generation_config.tool_choice === "validated" && is_validated_error(error)) {
				this.validated_ok = false;
				this.on_warning(`The Gemini API rejected schema-checked tool calls, so they're off for this session (tools still work, with the room's own checks). The API said: ${error.message}`);
				body.generation_config.tool_choice = "auto";
				interaction = await this.post(body, req.signal);
			} else if (block_codes([error.body?.error]).length > 0) {
				return refused(block_codes([error.body?.error]), null);	// Blocked outright: nothing to retry.
			} else {
				throw error;
			}
		}

		let message = to_message(interaction);
		if (typeof req.on_text === "function") {
			let text = message.content.filter(b => b.type === "text").map(b => b.text).join("\n\n");
			if (text) {
				req.on_text(text);				// Not streamed: the whole reply arrives at once.
			}
		}
		return message;
	},

	build_body: function(req) {

		let p = req.participant;

		let generation_config = {max_output_tokens: p.max_tokens};
		if (p.effort) {
			generation_config.thinking_level = p.effort;
		}
		if (req.show_thinking) {
			generation_config.thinking_summaries = "auto";
		}
		if (req.tools.length > 0) {
			generation_config.tool_choice = this.validated_ok && req.tools.some(t => t.strict) ? "validated" : "auto";
		}

		let body = {
			model: p.model,
			input: to_steps(req.messages),
			system_instruction: system_text(req.system),
			generation_config: generation_config,
			store: false,
		};
		if (req.tools.length > 0) {
			body.tools = req.tools.map(to_function_tool);
		}
		return body;
	},

	is_abort_error: is_abort_error,
};

// ------------------------------------------------------------------------------------------------
// Requests: Anthropic-style messages into Interactions steps.

// additionalProperties is dropped: it only matters to Anthropic's strict mode, and Gemini's older
// schema format rejected it. A tool that takes nothing (pass) gets no parameters at all, since
// that format also rejected an object with no properties.

function to_function_tool(t) {
	let tool = {type: "function", name: t.name, description: t.description};
	let schema = t.input_schema || {};
	if (schema.properties && Object.keys(schema.properties).length > 0) {
		tool.parameters = Object.assign({}, schema);
		delete tool.parameters.additionalProperties;
	}
	return tool;
}

function to_steps(messages) {

	let steps = [];
	let tool_names = Object.create(null);		// tool_use id -> name, for the function_result steps.

	for (let m of messages) {

		let content = typeof m.content === "string" ? [{type: "text", text: m.content}] : m.content;

		if (m.role === "assistant") {
			for (let b of content) {
				if (b.type === "tool_use") {
					tool_names[b.id] = b.name;
				}
				if (b.native) {
					steps.push(b.native);		// Exactly as Gemini sent it.
				} else if (b.type === "text") {
					steps.push({type: "model_output", content: [{type: "text", text: b.text}]});
				} else if (b.type === "tool_use") {
					steps.push({type: "function_call", id: b.id, name: b.name, arguments: b.input ?? {}});
				}
				// Anything else (thinking from some other API) can't be replayed here, and won't occur:
				// a participant's own turns all come from the same backend.
			}
			continue;
		}

		// User messages: tool results become function_result steps, and everything else goes
		// into one user_input step after them.

		let parts = [];
		for (let b of content) {
			if (b.type === "tool_result") {
				let step = {type: "function_result", call_id: b.tool_use_id, result: tool_result_text(b.content)};
				if (tool_names[b.tool_use_id]) {
					step.name = tool_names[b.tool_use_id];
				}
				if (b.is_error) {
					step.is_error = true;
				}
				steps.push(step);
			} else if (b.type === "text") {
				parts.push({type: "text", text: b.text});
			} else if (b.type === "image" && b.source?.type === "base64") {
				parts.push({type: "image", data: b.source.data, mime_type: b.source.media_type});
			}
		}
		if (parts.length > 0) {
			steps.push({type: "user_input", content: parts});
		}
	}

	return steps;
}

// ------------------------------------------------------------------------------------------------
// Responses: an Interaction into an Anthropic-style message.

function to_message(interaction) {

	let status = interaction?.status;
	let steps = Array.isArray(interaction?.steps) ? interaction.steps : [];

	// A safety or policy block can arrive as the interaction's errors or a step's; either way the
	// whole reply is treated as refused, and the room decides what to do (see make_step).

	let blocked = block_codes((interaction?.errors || []).concat(steps.map(s => s?.error)));
	if (blocked.length > 0) {
		return refused(blocked, interaction.usage);
	}

	if (["failed", "cancelled", "budget_exceeded"].includes(status)) {
		let detail = (interaction.errors || []).map(e => e?.message).filter(Boolean).join("; ");
		throw new Error(`Gemini interaction ${status}${detail ? `: ${detail}` : ""}`);
	}

	let content = [];
	let errors = [];

	for (let step of steps) {
		if (step.type === "thought") {
			let summary = (step.summary || []).filter(s => s.type === "text").map(s => s.text).join("\n\n");
			content.push({type: "thinking", thinking: summary, signature: step.signature || "", native: step});
		} else if (step.type === "function_call") {
			content.push({type: "tool_use", id: step.id, name: step.name, input: step.arguments ?? {}, native: step});
		} else if (step.type === "model_output") {
			if (step.error) {
				errors.push(step.error.message || JSON.stringify(step.error));
			}
			let text = (step.content || []).filter(c => c.type === "text").map(c => c.text).join("");
			if (text) {
				content.push({type: "text", text: text, native: step});
			}
		}
	}

	let has_calls = content.some(b => b.type === "tool_use");
	let has_text = content.some(b => b.type === "text");

	if (errors.length > 0 && !has_text && !has_calls) {
		throw new Error(`Gemini returned no reply: ${errors.join("; ")}`);
	}

	let stop_reason;
	if (status === "incomplete") {
		stop_reason = "max_tokens";				// Cut off, most likely by max_output_tokens.
	} else if (has_calls) {
		stop_reason = "tool_use";
	} else {
		stop_reason = "end_turn";
	}

	return {content, stop_reason, usage: to_usage(interaction.usage), model: interaction.model, id: interaction.id};
}

// Gemini's codes for output blocked by safety or policy filters. Recitation, language and
// "image_other" blocks aren't refusals, so they stay ordinary errors (the floor moves on).

const BLOCK_CODES = ["safety", "prohibited_content", "spii", "blocklist", "content_blocked", "image_safety", "image_prohibited_content"];

function block_codes(errors) {
	let found = [];
	for (let e of errors) {
		for (let v of [e?.code, e?.status, e?.reason]) {
			let code = typeof v === "string" ? v.toLowerCase() : "";
			if (BLOCK_CODES.includes(code) && !found.includes(code)) {
				found.push(code);
			}
		}
	}
	return found;
}

function refused(codes, usage) {
	return {content: [], stop_reason: "refusal", refusal: `Gemini blocked the reply (${codes.join(", ")})`, usage: to_usage(usage)};
}

// Gemini counts cached tokens inside total_input_tokens, and thinking separately from output;
// the room (like the Messages API) counts uncached input, cache reads and output (thinking
// included). There's no charge for writing to Gemini's implicit cache.

function to_usage(u) {
	u = u || {};
	let input = (u.total_input_tokens || 0) + (u.total_tool_use_tokens || 0);
	let cached = Math.min(u.total_cached_tokens || 0, input);
	return {
		input_tokens: input - cached,
		cache_read_input_tokens: cached,
		cache_creation_input_tokens: 0,
		output_tokens: (u.total_output_tokens || 0) + (u.total_thought_tokens || 0),
	};
}

// ------------------------------------------------------------------------------------------------

function is_validated_error(error) {
	return error instanceof APIError && error.status === 400 && /tool_choice|validated/i.test(error.message);
}

module.exports = {new_google_backend, to_steps, to_message, to_usage, BLOCK_CODES};
