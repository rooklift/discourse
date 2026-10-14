"use strict";

// The room: who is present, whose turn it is, what each model sees, and when it all ends.
// Front ends (the CLI now, maybe Electron later) drive it through the host_* methods and
// listen for its events. Nothing in here knows about terminals or windows.
//
// Events emitted:
//   "event"      (entry)            Every entry appended to the log (see append()).
//   "turn_start" ({name})           A model has the floor and a request is in flight.
//   "text_delta" ({name, delta})    Streamed reply text, for front ends that want it live.
//   "state"      (state)            Something in room.state() changed.
//   "closed"     ({reason})         The room is closed; run() is about to return.

const EventEmitter = require("events");
const pricing = require("./pricing");
const {build_system_prompt} = require("./prompt");

const TOOLS = [
	{
		name: "pass",
		description: "Say nothing this time. Use this when you have nothing you want to add right now; the floor moves on to someone else. If you're passing, don't also write a message.",
		input_schema: {type: "object", properties: {}},
	},
	{
		name: "leave_room",
		description: "Leave the room for good. You don't need a reason. If you want to say goodbye, write it as ordinary text in the same reply, before calling this. After leaving you receive no more messages.",
		input_schema: {
			type: "object",
			properties: {
				note_to_host: {
					type: "string",
					description: "Optional. A note that only the host sees, not the other models.",
				},
			},
		},
	},
];

const CLOSING_PHRASES = {
	budget: "the budget is nearly spent",
	turns: "the turn limit has been reached",
	quiet: "the conversation has gone quiet",
	alone: "only one model is left",
	host: null,							// Filled in with the host's name.
	errors: "of repeated errors",
};

const MAX_CONSECUTIVE_ERRORS = 3;

// ------------------------------------------------------------------------------------------------

function new_room(cfg, backend, opts = {}) {

	let room = Object.create(room_prototype);
	room.emitter = new EventEmitter();

	Object.assign(room, {
		cfg: cfg,
		backend: backend,
		random: opts.random || Math.random,		// Injectable for tests.

		participants: cfg.participants.map(p => ({
			name: p.name,
			cfg: p,
			system: build_system_prompt(cfg, p, opts.template ?? null),
			present: true,
			last_spoke: -1,						// Value of message_count when this model last spoke.
			turns: 0,
			cost: 0,
			usage: {input: 0, cache_read: 0, cache_write: 0, output: 0},
		})),

		log: [],								// Everything that happened, in order. The single source of truth.

		floor_queue: [],						// Names who were @mentioned and are owed the floor, in order.
		passed: new Set(),						// Names who passed (or failed) since the last message.
		last_speaker: null,						// Name of whoever sent the last message, host included.
		message_count: 0,

		turn_count: 0,							// Completed model turns (not counting failed requests).
		total_cost: 0,
		cost_known: true,
		consecutive_errors: 0,

		pending_host: [],						// Host messages waiting for the current turn to finish.
		paused: false,
		quiet: false,
		awaiting_host: null,					// Name of the model that handed the floor to the host, if any.
		in_flight: null,						// Name of the model whose request is running.
		abort_controller: null,
		close_request: null,					// {reason, farewell} once something has asked the room to close.
		closing: false,
		closed: false,
		waker: null,
	});

	return room;
}

const room_prototype = {

	on: function(name, fn) {
		this.emitter.on(name, fn);
		return this;
	},

	emit: function(name, payload) {
		this.emitter.emit(name, payload);
	},

	state: function() {
		return {
			paused: this.paused,
			quiet: this.quiet,
			awaiting_host: this.awaiting_host,
			in_flight: this.in_flight,
			closing: this.closing,
			closed: this.closed,
			turn_count: this.turn_count,
			total_cost: this.total_cost,
			cost_known: this.cost_known,
			present: this.present_models().map(p => p.name),
		};
	},

	emit_state: function() {
		this.emit("state", this.state());
	},

	append: function(entry) {
		entry.seq = this.log.length;
		entry.time = new Date().toISOString();
		this.log.push(entry);
		this.emit("event", entry);
		return entry;
	},

	notice: function(text) {
		return this.append({kind: "notice", text});
	},

	get_participant: function(name) {
		let lower = String(name).toLowerCase();
		return this.participants.find(p => p.name.toLowerCase() === lower) || null;
	},

	present_models: function() {
		return this.participants.filter(p => p.present);
	},

	// --------------------------------------------------------------------------------------------
	// Main loop.

	run: async function() {

		this.open();

		while (!this.closed) {

			this.apply_pending_host_messages();

			if (this.close_request) {
				await this.close(this.close_request.reason, this.close_request.farewell);
				break;
			}

			if (this.paused || this.quiet || this.awaiting_host) {
				await this.wait();
				continue;
			}

			let limit = this.limit_reached();
			if (limit) {
				this.close_request = {reason: limit, farewell: true};
				continue;
			}

			let next = this.choose_next();
			if (!next) {
				this.go_quiet();
				continue;
			}

			await this.take_turn(next);
		}
	},

	open: function() {
		let names = this.participants.map(p => p.name);
		this.notice(`The room is open. Here: ${names.join(", ")}, and ${this.cfg.host_name} (the host).`);
		if (this.cfg.first_speaker) {
			this.floor_queue.push(this.cfg.first_speaker);
		}
		if (this.cfg.opening_message) {
			this.pending_host.push(this.cfg.opening_message);
		}
		this.emit_state();
	},

	wait: function() {
		return new Promise(resolve => {
			this.waker = resolve;
		});
	},

	wake: function() {
		if (this.waker) {
			let w = this.waker;
			this.waker = null;
			w();
		}
	},

	limit_reached: function() {
		if (this.cfg.budget > 0 && this.total_cost >= this.cfg.budget * 0.9) {
			return "budget";
		}
		if (this.cfg.max_turns > 0 && this.turn_count >= this.cfg.max_turns) {
			return "turns";
		}
		if (this.present_models().length === 0) {
			return "empty";
		}
		if (!this.cfg.host_present && this.present_models().length === 1) {
			return "alone";
		}
		return null;
	},

	go_quiet: function() {
		if (this.cfg.host_present) {
			this.quiet = true;
			this.emit_state();
		} else {
			this.close_request = {reason: "quiet", farewell: true};
		}
	},

	// --------------------------------------------------------------------------------------------
	// The floor.

	mentions_in: function(text) {
		let found = [];
		let names = this.participants.map(p => p.name).sort((a, b) => b.length - a.length);
		let escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
		let re = new RegExp(`@(${escaped.join("|")})(?![A-Za-z0-9_-])`, "gi");
		for (let match of text.matchAll(re)) {
			let p = this.get_participant(match[1]);
			if (p && !found.includes(p.name)) {
				found.push(p.name);
			}
		}
		return found;
	},

	mentions_host: function(text) {
		let escaped = this.cfg.host_name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
		return new RegExp(`@${escaped}(?![A-Za-z0-9_-])`, "i").test(text);
	},

	on_message: function(author, text) {
		this.message_count++;
		this.passed.clear();
		this.last_speaker = author;
		let p = this.get_participant(author);
		if (p) {
			p.last_spoke = this.message_count;
		}
		let mentioned = this.mentions_in(text).filter(n => n !== author && this.get_participant(n).present);
		let rest = this.floor_queue.filter(n => n !== author && !mentioned.includes(n));
		this.floor_queue = mentioned.concat(rest);

		// A model that hands the floor to the host (and to no other model) gets the host's reply
		// next, so the room waits rather than asking the others first.

		if (p && this.cfg.host_present && !this.closing && mentioned.length === 0 && this.mentions_host(text)) {
			this.awaiting_host = p.name;
		}
	},

	eligible: function() {
		return this.present_models().filter(p => p.name !== this.last_speaker && !this.passed.has(p.name));
	},

	choose_next: function() {

		let eligible = this.eligible();
		if (eligible.length === 0) {
			return null;
		}

		while (this.floor_queue.length > 0) {
			let p = this.get_participant(this.floor_queue.shift());
			if (eligible.includes(p)) {
				return p;
			}
		}

		if (this.random() < this.cfg.floor_randomness) {
			return eligible[Math.floor(this.random() * eligible.length)];
		}

		let quietest = Math.min(...eligible.map(p => p.last_spoke));
		let candidates = eligible.filter(p => p.last_spoke === quietest);
		return candidates[Math.floor(this.random() * candidates.length)];
	},

	// --------------------------------------------------------------------------------------------
	// What a given model sees. Its own turns become assistant messages, replayed exactly as the
	// API returned them (thinking blocks must come back unmodified). Everything else since its
	// last turn is batched into one user message, with tool results first, as the API requires.

	render_for: function(entry, me) {
		if (entry.kind === "notice") {
			return `<notice>${entry.text}</notice>`;
		}
		if (entry.kind === "host") {
			return `<message from="${this.cfg.host_name} (host)">\n${entry.text}\n</message>`;
		}
		if (entry.kind === "turn" && entry.author !== me.name && entry.text) {
			return `<message from="${entry.author}">\n${entry.text}\n</message>`;
		}
		return "";								// Passes, errors and other models' silences are invisible.
	},

	build_view: function(me) {

		let messages = [];
		let parts = [];
		let tool_results = [];

		let flush = () => {
			let content = tool_results.map(tr => ({type: "tool_result", tool_use_id: tr.tool_use_id, content: tr.content}));
			if (parts.length > 0) {
				content.push({type: "text", text: parts.join("\n\n")});
			}
			if (content.length > 0) {
				messages.push({role: "user", content});
			}
			parts = [];
			tool_results = [];
		};

		for (let entry of this.log) {
			if (entry.kind === "turn" && entry.author === me.name) {
				if (entry.blocks.length === 0) {
					continue;
				}
				flush();
				messages.push({role: "assistant", content: entry.blocks});
				tool_results = entry.tool_results.slice();
			} else {
				let s = this.render_for(entry, me);
				if (s) {
					parts.push(s);
				}
			}
		}

		let has_new = parts.length > 0;
		flush();
		return {messages, has_new};
	},

	// --------------------------------------------------------------------------------------------
	// One model turn.

	take_turn: async function(p) {

		let {messages, has_new} = this.build_view(p);

		if (!has_new) {							// Nothing new to respond to. Shouldn't happen, but never send
			this.passed.add(p.name);			// a request that ends on the model's own turn.
			return;
		}

		this.in_flight = p.name;
		this.abort_controller = new AbortController();
		this.emit("turn_start", {name: p.name});
		this.emit_state();

		let response;

		try {
			response = await this.backend.send({
				participant: p.cfg,
				system: p.system,
				messages: messages,
				tools: TOOLS,
				show_thinking: this.cfg.show_thinking,
				cache_ttl: this.cfg.cache_ttl,
				signal: this.abort_controller.signal,
				on_text: (delta) => this.emit("text_delta", {name: p.name, delta}),
			});
		} catch (error) {
			this.in_flight = null;
			this.abort_controller = null;
			if (this.closed || (this.backend.is_abort_error && this.backend.is_abort_error(error))) {
				this.emit_state();
				return;
			}
			this.consecutive_errors++;
			this.passed.add(p.name);			// So the floor moves on.
			this.append({kind: "error", author: p.name, text: String(error?.message || error)});
			if (this.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
				if (this.cfg.host_present) {
					this.paused = true;
					this.append({kind: "error", author: null, text: `Paused after ${this.consecutive_errors} errors in a row. /resume to carry on.`});
				} else {
					this.close_request = {reason: "errors", farewell: false};
				}
			}
			this.emit_state();
			return;
		}

		this.in_flight = null;
		this.abort_controller = null;
		this.consecutive_errors = 0;

		this.record_response(p, response);
		this.emit_state();
	},

	record_response: function(p, response) {

		let usage = response.usage || {};
		let cost = pricing.cost_of_usage(p.cfg.price_tiers, usage, this.cfg.cache_ttl);

		p.turns++;
		this.turn_count++;
		p.usage.input += usage.input_tokens || 0;
		p.usage.cache_read += usage.cache_read_input_tokens || 0;
		p.usage.cache_write += usage.cache_creation_input_tokens || 0;
		p.usage.output += usage.output_tokens || 0;
		if (cost === null) {
			this.cost_known = false;
		} else {
			p.cost += cost;
			this.total_cost += cost;
		}

		let content = Array.isArray(response.content) ? response.content : [];
		let text = content.filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
		let thinking = content.filter(b => b.type === "thinking" && b.thinking).map(b => b.thinking);
		let tool_uses = content.filter(b => b.type === "tool_use");
		let note = "";

		let blocks = [];
		let tool_results = [];
		let action;

		if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {

			// A cut-off reply may hold a half-written tool call. Keep only the text, which is
			// allowed (earlier thinking may be dropped when no tool call is pending).

			blocks = text ? [{type: "text", text}] : [];
			action = text ? "speak" : "silent";

		} else {

			let leave = tool_uses.find(t => t.name === "leave_room");
			let pass = tool_uses.some(t => t.name === "pass");

			action = leave ? "leave" : (text ? "speak" : (pass ? "pass" : "silent"));
			note = typeof leave?.input?.note_to_host === "string" ? leave.input.note_to_host.trim() : "";

			if (text || tool_uses.length > 0) {
				blocks = content.map(clean_block).filter(b => b !== null);
			}

			for (let t of tool_uses) {
				tool_results.push({tool_use_id: t.id, content: tool_result_text(t.name, text)});
			}
		}

		this.append({
			kind: "turn",
			author: p.name,
			action: action,
			text: text,
			thinking: thinking,
			note_to_host: note,
			stop_reason: response.stop_reason || "",
			blocks: blocks,
			tool_results: tool_results,
			usage: usage,
			cost: cost,
			closing: this.closing,
		});

		if (text) {
			this.on_message(p.name, text);
		} else {
			this.passed.add(p.name);
		}

		if (action === "leave") {
			p.present = false;
			this.floor_queue = this.floor_queue.filter(n => n !== p.name);
			this.notice(`${p.name} has left the room.`);
		}
	},

	// --------------------------------------------------------------------------------------------
	// Closing.

	close: async function(reason, farewell) {

		this.closing = true;
		this.quiet = false;
		this.paused = false;
		this.awaiting_host = null;
		this.emit_state();

		let present = this.present_models();

		if (farewell && this.cfg.farewell_round && present.length > 0) {

			let phrase = reason === "host" ? `${this.cfg.host_name} is closing it` : (CLOSING_PHRASES[reason] || reason);
			this.notice(`The room is closing because ${phrase}. Everyone gets one last turn to say anything they'd like, or to pass. After that, the room closes.`);

			// Quietest first, so that whoever has said least gets the first word.

			let order = present.slice().sort((a, b) => a.last_spoke - b.last_spoke);

			for (let p of order) {
				this.apply_pending_host_messages();
				if (this.closed || !p.present) {
					continue;
				}
				if (this.cfg.budget > 0 && this.total_cost >= this.cfg.budget) {
					break;
				}
				await this.take_turn(p);
			}
		}

		if (!this.closed) {
			this.apply_pending_host_messages();
			this.notice("The room is now closed.");
			this.finish(reason);
		}
	},

	finish: function(reason) {
		this.closed = true;
		this.closing = false;
		this.emit_state();
		this.emit("closed", {reason});
		this.wake();
	},

	// --------------------------------------------------------------------------------------------
	// Host controls. These are what a front end calls.

	host_say: function(text) {
		text = String(text).trim();
		if (!text || this.closed) {
			return;
		}
		this.pending_host.push(text);			// Applied between turns, so no model's history shows a
		this.wake();							// message it didn't actually see before replying.
	},

	apply_pending_host_messages: function() {
		while (this.pending_host.length > 0) {
			let text = this.pending_host.shift();
			this.append({kind: "host", text});
			this.on_message(this.cfg.host_name, text);
			this.quiet = false;
			this.awaiting_host = null;
		}
	},

	host_pause: function() {
		this.paused = true;
		this.emit_state();
	},

	host_resume: function() {
		this.paused = false;
		this.awaiting_host = null;				// Decline the floor: the other models carry on.
		if (this.quiet) {
			this.quiet = false;					// Nudge: everyone may speak again, including the last speaker.
			this.passed.clear();
			this.last_speaker = null;
		}
		this.emit_state();
		this.wake();
	},

	host_give_floor: function(name) {
		let p = this.get_participant(name);
		if (!p || !p.present) {
			return false;
		}
		this.floor_queue = [p.name].concat(this.floor_queue.filter(n => n !== p.name));
		this.passed.delete(p.name);
		if (this.last_speaker === p.name) {
			this.last_speaker = null;
		}
		this.quiet = false;
		this.paused = false;
		this.awaiting_host = null;
		this.emit_state();
		this.wake();
		return true;
	},

	host_end: function() {						// Graceful: farewell round, then close.
		if (!this.close_request && !this.closing && !this.closed) {
			this.close_request = {reason: "host", farewell: true};
			this.wake();
		}
	},

	host_quit: function() {						// Immediate: abort any request and close without farewells.
		if (this.closed) {
			return;
		}
		if (this.abort_controller) {
			this.abort_controller.abort();
		}
		this.notice("The room was closed by the host.");
		this.finish("quit");
	},
};

// ------------------------------------------------------------------------------------------------

function clean_block(b) {
	if (b.type === "text") {
		return b.text.trim() ? {type: "text", text: b.text} : null;
	}
	if (b.type === "tool_use") {
		return {type: "tool_use", id: b.id, name: b.name, input: b.input ?? {}};
	}
	return b;									// thinking / redacted_thinking: must be passed back unchanged.
}

function tool_result_text(name, text) {
	if (name === "pass") {
		return text ? "Your message was posted." : "You passed.";
	}
	if (name === "leave_room") {
		return "You have left the room.";
	}
	return `Unknown tool: ${name}`;
}

module.exports = {new_room, TOOLS};
