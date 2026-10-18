"use strict";

// Talks to OpenAI's models through the Responses API
// (https://developers.openai.com/api/docs/guides/reasoning).
//
// Like the Gemini backend, it translates the room's Anthropic-style messages into the API's own
// shapes and the reply back again, so the room doesn't need to know who made a participant.
//
// It's stateless ("store": false): every request carries that model's whole view of the
// conversation. OpenAI's reasoning comes back as "reasoning" items carrying encrypted_content,
// which must be passed back on later requests, along with the items that followed them, exactly
// as received. So each block this backend returns carries its output item as "native", and any
// block with a "native" item is sent back as that item, untouched.
//
// Strict function calling needs every property to be required, so for tools with required
// fields, optional properties are sent as nullable and required, and any nulls the model fills
// in are dropped before the room sees the call.

const {new_poster, APIError, is_abort_error, system_text, tool_result_text} = require("./http");

const ENDPOINT = "https://api.openai.com/v1/responses";

// opts: {max_retries, on_warning, fetch, sleep, endpoint}. fetch and sleep are for tests.

function new_openai_backend(api_key, opts = {}) {
	let backend = Object.create(openai_prototype);
	backend.on_warning = typeof opts.on_warning === "function" ? opts.on_warning : () => {};
	backend.post = new_poster({
		api_name: "OpenAI",
		url: opts.endpoint || ENDPOINT,
		headers: {"authorization": `Bearer ${api_key}`},
		max_retries: opts.max_retries,
		fetch: opts.fetch,
		sleep: opts.sleep,
	});
	backend.strict_ok = true;				// Becomes false if the API ever rejects our strict schemas.
	return backend;
}

const openai_prototype = {

	// req: {participant, system, messages, tools, show_thinking, cache_ttl, signal, on_text}
	// Resolves to an Anthropic-shaped message: {content, stop_reason, usage}.

	send: async function(req) {

		let body = this.build_body(req);

		let response;
		try {
			response = await this.post(body, req.signal);
		} catch (error) {

			// As on the Claude side, strict schemas are a safeguard, not a necessity.

			if (body.tools?.some(t => t.strict) && is_strict_error(error)) {
				this.strict_ok = false;
				this.on_warning(`The OpenAI API rejected the strict tool schemas, so they're off for this session (tools still work, with the room's own checks). The API said: ${error.message}`);
				body.tools = req.tools.map(t => to_function_tool(t, false));
				response = await this.post(body, req.signal);
			} else if (is_refusal_error(error)) {

				// Some prompts are declined before the model replies at all.

				return {content: [], stop_reason: "refusal", refusal: `OpenAI declined the request: ${error.message}`, usage: to_usage(null)};
			} else {
				throw error;
			}
		}

		let message = to_message(response);
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

		let body = {
			model: p.model,
			instructions: system_text(req.system),
			input: to_input(req.messages),
			max_output_tokens: p.max_tokens,
			store: false,
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: `discourse-${p.name}-${p.model}`.slice(0, 64),	// Keeps a model's requests on the same cache.
		};

		let reasoning = {};
		if (p.effort) {
			reasoning.effort = p.effort;
		}
		if (req.show_thinking) {
			reasoning.summary = "auto";
		}
		if (Object.keys(reasoning).length > 0) {
			body.reasoning = reasoning;
		}

		if (req.tools.length > 0) {
			body.tools = req.tools.map(t => to_function_tool(t, this.strict_ok));
		}
		return body;
	},

	is_abort_error: is_abort_error,
};

// ------------------------------------------------------------------------------------------------
// Tools.

// The room marks tools with required fields as strict. OpenAI's strict mode also needs every
// property listed as required, so optional ones become nullable instead. Only flat schemas are
// converted; anything else is sent without strict.

function to_function_tool(t, strict_ok) {
	let schema = t.input_schema || {type: "object", properties: {}};
	let strict_schema = t.strict && strict_ok ? strictify(schema) : null;
	if (strict_schema) {
		return {type: "function", name: t.name, description: t.description, parameters: strict_schema, strict: true};
	}
	let parameters = Object.assign({}, schema);
	delete parameters.additionalProperties;
	return {type: "function", name: t.name, description: t.description, parameters, strict: false};
}

function strictify(schema) {
	let properties = schema.properties || {};
	let required = new Set(schema.required || []);
	let out = {};
	for (let [key, prop] of Object.entries(properties)) {
		if (typeof prop.type !== "string" || prop.type === "object" || prop.type === "array") {
			return null;
		}
		if (required.has(key)) {
			out[key] = prop;
			continue;
		}
		let nullable = Object.assign({}, prop, {type: [prop.type, "null"]});
		if (Array.isArray(prop.enum)) {
			nullable.enum = prop.enum.concat(null);
		}
		out[key] = nullable;
	}
	return {type: "object", properties: out, required: Object.keys(out), additionalProperties: false};
}

// ------------------------------------------------------------------------------------------------
// Requests: Anthropic-style messages into Responses input items.

function to_input(messages) {

	let items = [];

	for (let m of messages) {

		let content = typeof m.content === "string" ? [{type: "text", text: m.content}] : m.content;

		if (m.role === "assistant") {
			let turn = [];
			for (let b of content) {
				if (b.native) {
					turn.push(b.native);			// Exactly as OpenAI sent it.
				} else if (b.type === "text") {
					turn.push({role: "assistant", content: b.text});
				} else if (b.type === "tool_use") {
					turn.push({type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {})});
				}
			}

			// A reasoning item must be followed by the item it led to; the API refuses it alone. The
			// room drops empty replies and cut-off tool calls, so drop any reasoning left stranded.

			items.push(...turn.filter((item, i) => item.type !== "reasoning" || (turn[i + 1] && turn[i + 1].type !== "reasoning")));
			continue;
		}

		// User messages: tool results become function_call_output items, and everything else goes
		// into one user message after them.

		let parts = [];
		for (let b of content) {
			if (b.type === "tool_result") {
				items.push({type: "function_call_output", call_id: b.tool_use_id, output: tool_result_text(b.content)});
			} else if (b.type === "text") {
				parts.push({type: "input_text", text: b.text});
			} else if (b.type === "image" && b.source?.type === "base64") {
				parts.push({type: "input_image", image_url: `data:${b.source.media_type};base64,${b.source.data}`});
			}
		}
		if (parts.length > 0) {
			items.push({role: "user", content: parts});
		}
	}

	return items;
}

// ------------------------------------------------------------------------------------------------
// Responses: a Response object into an Anthropic-style message.

function to_message(response) {

	let status = response?.status;
	if (status === "failed" || status === "cancelled") {
		let detail = response.error?.message;
		throw new Error(`OpenAI response ${status}${detail ? `: ${detail}` : ""}`);
	}

	let content = [];
	let refused = false;

	for (let item of Array.isArray(response?.output) ? response.output : []) {
		if (item.type === "reasoning") {
			let summary = (item.summary || []).filter(s => s.type === "summary_text").map(s => s.text).join("\n\n");
			content.push({type: "thinking", thinking: summary, signature: "", native: item});
		} else if (item.type === "function_call") {
			content.push({type: "tool_use", id: item.call_id, name: item.name, input: parse_arguments(item.arguments), native: item});
		} else if (item.type === "message") {
			let parts = item.content || [];
			let text = parts.map(c => c.type === "output_text" ? c.text : (c.type === "refusal" ? c.refusal : "")).join("");
			if (parts.some(c => c.type === "refusal")) {
				refused = true;
			}
			if (text) {
				content.push({type: "text", text: text, native: item});
			}
		}
	}

	let stop_reason;
	let refusal = "";
	if (status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
		stop_reason = "refusal";
		refusal = "OpenAI's content filter stopped the reply";
	} else if (status === "incomplete") {
		stop_reason = "max_tokens";
	} else if (refused) {
		stop_reason = "refusal";
		refusal = "the model returned a refusal";
	} else if (content.some(b => b.type === "tool_use")) {
		stop_reason = "tool_use";
	} else {
		stop_reason = "end_turn";
	}

	let message = {content, stop_reason, usage: to_usage(response?.usage), model: response?.model, id: response?.id};
	if (refusal) {
		message.refusal = refusal;
	}
	return message;
}

// Strict calls fill optional fields with null; the room expects them left out. A call whose
// arguments aren't valid JSON (possible without strict) arrives with no fields, and the room's
// own checks say what was missing.

function parse_arguments(text) {
	let parsed;
	try {
		parsed = JSON.parse(text || "{}");
	} catch (error) {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null));
}

// OpenAI counts cached and cache-written tokens inside input_tokens, and reasoning inside
// output_tokens. The room counts uncached input, cache reads, cache writes and output.

function to_usage(u) {
	u = u || {};
	let input = u.input_tokens || 0;
	let cached = Math.min(u.input_tokens_details?.cached_tokens || 0, input);
	let written = Math.min(u.input_tokens_details?.cache_write_tokens || 0, input - cached);
	return {
		input_tokens: input - cached - written,
		cache_read_input_tokens: cached,
		cache_creation_input_tokens: written,
		output_tokens: u.output_tokens || 0,
	};
}

function is_refusal_error(error) {
	return error instanceof APIError && error.status === 400
		&& (error.body?.error?.code === "invalid_prompt" || /usage polic/i.test(error.message));
}

function is_strict_error(error) {
	return error instanceof APIError && error.status === 400 && /strict|schema|required/i.test(error.message);
}

module.exports = {new_openai_backend, to_input, to_message, to_usage, to_function_tool};
