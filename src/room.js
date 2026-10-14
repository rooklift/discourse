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
const {new_storage, FILE_TOOLS, FILE_TOOL_NAMES, run_file_tool, LIMITS} = require("./storage");

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
const MAX_TOOL_STEPS = 10;					// API calls per turn, when a model uses its file tools.

// ------------------------------------------------------------------------------------------------

function new_room(cfg, backend, opts = {}) {

	let room = Object.create(room_prototype);
	room.emitter = new EventEmitter();

	Object.assign(room, {
		cfg: cfg,
		backend: backend,
		random: opts.random || Math.random,		// Injectable for tests.

		participants: cfg.participants.map(p => {
			let storage = cfg.storage_dir ? new_storage(cfg.storage_dir, p.name) : null;
			let storage_info = storage ? {listing: storage.listing(), limits: LIMITS} : null;
			return {
				name: p.name,
				cfg: p,
				storage: storage,					// Private folder, or null if storage is off.
				tools: storage ? TOOLS.concat(FILE_TOOLS) : TOOLS,
				system: build_system_prompt(cfg, p, opts.template ?? null, storage_info),
				present: true,
				last_spoke: -1,						// Value of message_count when this model last spoke.
				turns: 0,
				cost: 0,
				usage: {input: 0, cache_read: 0, cache_write: 0, output: 0},
			};
		}),

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
		turn_in_progress: null,					// {p, steps} of the running turn, for host_quit().
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
			let content = tool_results.map(tool_result_block);
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

				// A turn is one or more API calls ("steps"). Each step becomes an assistant message,
				// and its tool results open the following user message: on their own between
				// steps, or ahead of everyone else's news after the last step.

				for (let step of entry.steps) {
					if (step.blocks.length === 0) {
						continue;
					}
					flush();
					messages.push({role: "assistant", content: step.blocks});
					tool_results = step.tool_results.slice();
				}
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

		// A turn is a short loop: while the model is using its file tools, run them and call
		// again, so it can read or write before it speaks. Anything else ends the turn.

		// The turn in progress is visible to host_quit(), which records any steps already taken
		// (files already written) before it closes the room, since closing may end the process.

		let steps = [];
		let turn = {p, steps};
		this.turn_in_progress = turn;
		let conversation = messages.slice();
		let failure = null;

		let stop_quietly = () => {
			this.in_flight = null;
			this.abort_controller = null;
			if (this.turn_in_progress === turn) {	// Not already recorded by host_quit().
				this.turn_in_progress = null;
				if (steps.length > 0) {
					this.record_turn(p, steps);
				}
			}
			this.emit_state();
		};

		while (true) {

			let response;

			try {
				response = await this.backend.send({
					participant: p.cfg,
					system: p.system,
					messages: conversation,
					tools: p.tools,
					show_thinking: this.cfg.show_thinking,
					cache_ttl: this.cfg.cache_ttl,
					signal: this.abort_controller.signal,
					on_text: (delta) => this.emit("text_delta", {name: p.name, delta}),
				});
			} catch (error) {
				if (this.closed || (this.backend.is_abort_error && this.backend.is_abort_error(error))) {
					stop_quietly();
					return;
				}
				failure = error;
				break;
			}

			if (this.closed) {						// A reply that arrived after /quit: don't act on it.
				stop_quietly();
				return;
			}

			let turn_text = steps.map(s => s.text).concat(response_text(response)).join("");
			let step = this.make_step(p, response, turn_text, steps);

			if (this.closed) {						// Closed while running this step's tools (by an event
				stop_quietly();						// listener): host_quit() has already recorded the turn.
				return;
			}
			if (step.ends_turn) {
				break;
			}
			if (steps.length >= MAX_TOOL_STEPS) {
				step.limit_note = `stopped after ${MAX_TOOL_STEPS} steps`;
				break;
			}
			if (this.cfg.budget > 0 && this.total_cost >= this.cfg.budget) {
				step.limit_note = "stopped: budget spent";
				break;
			}

			conversation.push({role: "assistant", content: step.blocks});
			conversation.push({role: "user", content: step.tool_results.map(tool_result_block)});
		}

		this.in_flight = null;
		this.abort_controller = null;
		this.turn_in_progress = null;

		if (steps.length > 0) {
			this.consecutive_errors = 0;
			this.record_turn(p, steps);
		}

		if (failure) {
			this.on_error(p, failure, steps.length > 0);
		}

		this.emit_state();
	},

	on_error: function(p, error, partial) {
		if (!partial) {
			this.consecutive_errors++;
			this.passed.add(p.name);			// So the floor moves on.
		}
		this.append({kind: "error", author: p.name, text: String(error?.message || error)});
		if (this.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
			if (this.cfg.host_present) {
				this.paused = true;
				this.append({kind: "error", author: null, text: `Paused after ${this.consecutive_errors} errors in a row. /resume to carry on.`});
			} else {
				this.close_request = {reason: "errors", farewell: false};
			}
		}
	},

	// Usage and cost for one API call.

	account: function(p, usage) {
		let cost = pricing.cost_of_usage(p.cfg.price_tiers, usage, this.cfg.cache_ttl);
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
		return cost;
	},

	// Turns one API response into a step: the blocks to replay, the tool results to send back
	// (running any file tools now), and whether the turn is over. The step joins the turn's
	// steps before any tool runs or any event fires, so if a listener closes the room midway,
	// host_quit() records it with whatever it has done so far.

	make_step: function(p, response, turn_text, steps) {

		let usage = response.usage || {};
		let cost = this.account(p, usage);

		let content = Array.isArray(response.content) ? response.content : [];
		let text = response_text(response);
		let step = {
			text: text,
			thinking: content.filter(b => b.type === "thinking" && b.thinking).map(b => b.thinking),
			stop_reason: response.stop_reason || "",
			blocks: [],
			tool_results: [],
			file_ops: [],
			pass: false,
			leave: null,
			usage: usage,
			cost: cost,
			ends_turn: true,
		};
		steps.push(step);

		if (step.stop_reason === "max_tokens" || step.stop_reason === "refusal") {

			// A cut-off reply may hold a half-written tool call. Keep only the text, which is
			// allowed (thinking may be dropped when no tool call is pending).

			step.blocks = text.trim() ? [{type: "text", text: text.trim()}] : [];
			return step;
		}

		let tool_uses = content.filter(b => b.type === "tool_use");

		if (text.trim() || tool_uses.length > 0) {
			step.blocks = content.map(clean_block).filter(b => b !== null);
		}

		let author = `${p.cfg.full_name} (${p.cfg.model})`;
		let used_files = false;

		for (let t of tool_uses) {
			if (this.closed) {						// Closed mid-step: run nothing more.
				step.tool_results.push({tool_use_id: t.id, content: "Not run: the room has closed.", is_error: true});
				continue;
			}
			if (t.name === "pass") {
				step.pass = true;
				step.tool_results.push({tool_use_id: t.id, content: turn_text.trim() ? "Your message was posted." : "You passed."});
			} else if (t.name === "leave_room") {
				step.leave = t;
				step.tool_results.push({tool_use_id: t.id, content: "You have left the room."});
			} else if (FILE_TOOL_NAMES.includes(t.name) && p.storage) {
				used_files = true;
				let r;
				try {
					r = run_file_tool(p.storage, t, author);
				} catch (error) {						// run_file_tool shouldn't throw, but a tool call must never end the session.
					r = {content: "Error: the file tool failed unexpectedly.", is_error: true, summary: `tool ${t.name} failed unexpectedly`};
				}
				step.file_ops.push({tool: t.name, summary: r.summary, is_error: r.is_error});
				step.tool_results.push({tool_use_id: t.id, content: r.content, is_error: r.is_error});

				// Logged now, not at the end of the turn, so the transcript has it even if the
				// session dies during a later step. The step is complete before listeners run.

				this.append({kind: "file_op", author: p.name, tool: t.name, summary: r.summary, is_error: r.is_error});
			} else {
				step.tool_results.push({tool_use_id: t.id, content: `Unknown tool: ${t.name}`, is_error: true});
			}
		}

		step.ends_turn = !(used_files && step.stop_reason === "tool_use" && !step.pass && !step.leave);
		return step;
	},

	record_turn: function(p, steps) {

		p.turns++;
		this.turn_count++;

		let text = steps.map(s => s.text.trim()).filter(Boolean).join("\n\n");
		let leave = steps.map(s => s.leave).find(Boolean) || null;
		let pass = steps.some(s => s.pass);
		let action = leave ? "leave" : (text ? "speak" : (pass ? "pass" : "silent"));
		let note = typeof leave?.input?.note_to_host === "string" ? leave.input.note_to_host.trim() : "";
		let costs = steps.map(s => s.cost);
		let last = steps[steps.length - 1];

		this.append({
			kind: "turn",
			author: p.name,
			action: action,
			text: text,
			thinking: steps.flatMap(s => s.thinking),
			file_ops: steps.flatMap(s => s.file_ops),
			note_to_host: note,
			stop_reason: last.stop_reason,
			limit_note: last.limit_note || "",
			steps: steps.map(s => ({blocks: s.blocks, tool_results: s.tool_results, usage: s.usage})),
			cost: costs.includes(null) ? null : costs.reduce((a, b) => a + b, 0),
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
		let turn = this.turn_in_progress;			// Record what the interrupted turn already did,
		this.turn_in_progress = null;				// before "closed" lets the front end exit.
		if (turn && turn.steps.length > 0) {
			this.record_turn(turn.p, turn.steps);
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

function response_text(response) {
	let content = Array.isArray(response.content) ? response.content : [];
	return content.filter(b => b.type === "text").map(b => b.text).join("\n\n");
}

function tool_result_block(tr) {
	let block = {type: "tool_result", tool_use_id: tr.tool_use_id, content: tr.content};
	if (tr.is_error) {
		block.is_error = true;
	}
	return block;
}

module.exports = {new_room, TOOLS};
