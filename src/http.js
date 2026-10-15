"use strict";

// JSON POSTs with retries, for the backends that call an API with fetch directly (Gemini and
// OpenAI). The Claude backend uses Anthropic's SDK, which does its own retrying.

const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];
const MAX_RETRY_DELAY = 30000;

class APIError extends Error {
	constructor(api_name, status, message, body) {
		super(`${api_name} API error ${status}: ${message}`);
		this.name = "APIError";
		this.api_name = api_name;
		this.status = status;
		this.body = body;
	}
}

// Makes a poster for one API. opts: {api_name, url, headers, max_retries, fetch, sleep}; fetch
// and sleep can be replaced for tests. The poster resolves to the parsed JSON reply, retrying
// rate limits, server errors and dropped connections with backoff (honouring Retry-After), and
// throws an APIError for any other failure.

function new_poster(opts) {

	let fetch_fn = opts.fetch || ((...args) => fetch(...args));
	let sleep = opts.sleep || abortable_sleep;
	let max_retries = opts.max_retries ?? 4;

	return async function post(body, signal) {
		for (let attempt = 0; ; attempt++) {
			let response;
			try {
				response = await fetch_fn(opts.url, {
					method: "POST",
					headers: Object.assign({"content-type": "application/json"}, opts.headers),
					body: JSON.stringify(body),
					signal: signal,
				});
			} catch (error) {
				if (is_abort_error(error)) {
					throw error;
				}
				if (attempt >= max_retries) {
					let cause = error?.cause?.message || error?.cause?.code;
					throw new Error(`Couldn't reach the ${opts.api_name} API: ${error.message}${cause ? ` (${cause})` : ""}`);
				}
				await sleep(retry_delay(attempt, null), signal);
				continue;
			}

			if (response.ok) {
				return await response.json();
			}

			let text = await response.text().catch(() => "");
			if (RETRY_STATUSES.includes(response.status) && attempt < max_retries) {
				await sleep(retry_delay(attempt, response.headers.get("retry-after")), signal);
				continue;
			}
			let parsed = null;
			try {
				parsed = JSON.parse(text);
			} catch (error) {
				// Not JSON; use the raw text.
			}
			let message = parsed?.error?.message || text.slice(0, 500) || response.statusText || "request failed";
			throw new APIError(opts.api_name, response.status, message, parsed);
		}
	};
}

function is_abort_error(error) {
	return error?.name === "AbortError";
}

function retry_delay(attempt, retry_after) {
	let seconds = Number(retry_after);
	if (retry_after && Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, MAX_RETRY_DELAY);
	}
	return Math.min(1000 * 2 ** attempt * (0.75 + Math.random() * 0.5), MAX_RETRY_DELAY);
}

function abortable_sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abort_error());
			return;
		}
		let timer = setTimeout(() => {
			signal?.removeEventListener("abort", on_abort);
			resolve();
		}, ms);
		let on_abort = () => {
			clearTimeout(timer);
			reject(abort_error());
		};
		signal?.addEventListener("abort", on_abort, {once: true});
	});
}

function abort_error() {
	let error = new Error("The request was aborted.");
	error.name = "AbortError";
	return error;
}

// Text of a system prompt given as a string or as content blocks.

function system_text(system) {
	if (Array.isArray(system)) {
		return system.filter(b => b.type === "text").map(b => b.text).join("\n\n");
	}
	return String(system ?? "");
}

// Text of a tool result's content, which the room gives as a string.

function tool_result_text(content) {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(b => b.type === "text").map(b => b.text).join("\n");
	}
	return String(content ?? "");
}

module.exports = {new_poster, APIError, is_abort_error, system_text, tool_result_text};
