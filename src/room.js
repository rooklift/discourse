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
const {PROVIDERS} = require("./config");
const {build_system_prompt, clock_time} = require("./prompt");
const {new_storage, make_file_tools, FILE_TOOL_NAMES, run_file_tool, LIMITS} = require("./storage");
const {UTILITY_TOOLS, UTILITY_TOOL_NAMES, run_utility_tool, new_envelopes, describe_opened} = require("./utility_tools");

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
	{
		name: "sit_out",
		description: "Sit out for a while: stop taking turns until someone @mentions you, for example while a game you're not in plays out. The others are told you're sitting out and that an @mention brings you back. When you're back, you'll see everything that happened meanwhile. You can write a message in the same reply.",
		input_schema: {type: "object", properties: {}},
	},
	{
		name: "note_to_host",
		description: "Leave the host a note, without stopping the room: for a question or comment that doesn't need an answer right now. Only the host sees it; the other models aren't told. The host may not read it straight away. You can still write a message to the room in the same reply.",
		strict: true,
		input_schema: {
			type: "object",
			properties: {
				note: {type: "string", description: "The note."},
				reply: {type: "string", enum: ["not needed", "when you can"], description: "Optional. Whether you'd like a reply. Default: not needed."},
			},
			required: ["note"],
			additionalProperties: false,
		},
	},
	{
		name: "room_status",
		description: "Check how much of the room's time and budget is left, and who's here. Only you see the answer. Useful before starting something long, like a game.",
		input_schema: {type: "object", properties: {}},
	},
];

const ROOM_TOOL_NAMES = ["note_to_host", "room_status"];	// Run by the room itself; like file tools, the turn carries on.
const MAX_NOTE = 4000;

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
const MAX_IMAGES = 20;						// Images the host can share per session; every request resends them all.

// ------------------------------------------------------------------------------------------------

function new_room(cfg, backend, opts = {}) {

	let room = Object.create(room_prototype);
	room.emitter = new EventEmitter();

	// One folder every model can use, beside their private ones.

	let shared = cfg.storage_dir ? new_storage(cfg.storage_dir, "shared") : null;
	let file_tools = shared ? make_file_tools(true) : [];

	Object.assign(room, {
		cfg: cfg,
		backend: backend,
		shared_storage: shared,
		envelopes: new_envelopes(),				// Secrets for games; this session only.
		random: opts.random || Math.random,		// Injectable for tests.

		participants: cfg.participants.map(p => {
			let storage = cfg.storage_dir ? new_storage(cfg.storage_dir, p.model) : null;	// Named by model ID, not room name.
			let storage_info = storage ? {listing: storage.listing(), shared_listing: shared.listing(), limits: LIMITS} : null;
			return {
				name: p.name,
				cfg: p,
				storage: storage,					// Private folder, or null if storage is off.
				tools: TOOLS.concat(UTILITY_TOOLS, storage ? file_tools : []),
				system: build_system_prompt(cfg, p, opts.template ?? null, storage_info),
				present: true,
				sitting_out: false,					// True after sit_out, until someone @mentions this model.
				last_spoke: -1,						// Value of message_count when this model last spoke.
				last_floor: -1,						// Value of floor_count when this model last had the floor (spoke, passed or failed).
				turns: 0,
				cost: 0,
				cost_known: true,
				usage: {input: 0, cache_read: 0, cache_write: 0, output: 0},
			};
		}),

		log: [],								// Everything that happened, in order. The single source of truth.

		floor_queue: [],						// Names who were @mentioned and are owed the floor, in order.
		passed: new Set(),						// Names who passed (or failed) since the last message.
		last_speaker: null,						// Name of whoever sent the last message, host included.
		message_count: 0,
		floor_count: 0,							// Turns taken, passes and failures included; drives the rotation.

		turn_count: 0,							// Completed model turns (not counting failed requests).
		total_cost: 0,
		cost_known: true,
		consecutive_errors: 0,

		pending_host: [],						// Host messages ({text, images}) waiting for the current turn to finish.
		image_count: 0,							// Images shared so far, for numbering.
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
			sitting_out: this.present_models().filter(p => p.sitting_out).map(p => p.name),
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

	// Something the host should know about how the session is running, such as a backend turning
	// off strict tool schemas. Logged (so the transcript has it) but never shown to the models.

	warn: function(text) {
		return this.append({kind: "warning", text: String(text)});
	},

	get_participant: function(name) {
		let lower = String(name).toLowerCase();
		return this.participants.find(p => p.name.toLowerCase() === lower) || null;
	},

	// Every note left for the host this session, from note_to_host and from leaving:
	// [{author, text, reply}], in order.

	notes_for_host: function() {
		let notes = [];
		for (let e of this.log) {
			if (e.kind === "host_note") {
				notes.push({author: e.author, text: e.text, reply: e.reply});
			} else if (e.kind === "turn" && e.note_to_host) {
				notes.push({author: e.author, text: e.note_to_host, reply: "not needed"});
			}
		}
		return notes;
	},

	// Spending per provider, in the order they first appear in the config:
	// [{provider, company, cost, known}].

	cost_by_provider: function() {
		let groups = [];
		for (let p of this.participants) {
			let provider = p.cfg.provider || "anthropic";
			let g = groups.find(g => g.provider === provider);
			if (!g) {
				g = {provider, company: PROVIDERS[provider]?.company || provider, cost: 0, known: true};
				groups.push(g);
			}
			g.cost += p.cost;
			g.known = g.known && p.cost_known;
		}
		return groups;
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
		let opening_images = Array.isArray(this.cfg.opening_images) ? this.cfg.opening_images : [];
		let opening_files = Array.isArray(this.cfg.opening_files) ? this.cfg.opening_files : [];
		if (this.cfg.opening_message || opening_images.length > 0 || opening_files.length > 0) {
			this.pending_host.push({text: this.cfg.opening_message || "", images: opening_images, files: opening_files});
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
		for (let n of mentioned) {
			this.get_participant(n).sitting_out = false;		// An @mention brings a model back.
		}
		let rest = this.floor_queue.filter(n => n !== author && !mentioned.includes(n));
		this.floor_queue = mentioned.concat(rest);

		// A model that hands the floor to the host (and to no other model) gets the host's reply
		// next, so the room waits rather than asking the others first.

		if (p && this.cfg.host_present && !this.closing && mentioned.length === 0 && this.mentions_host(text)) {
			this.awaiting_host = p.name;
		}
	},

	eligible: function() {
		return this.present_models().filter(p => p.name !== this.last_speaker && !this.passed.has(p.name) && !p.sitting_out);
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

		// Whoever has gone longest without the floor. Passing counts as having had it, or a model
		// that passes before it has spoken would be picked again after every message.

		let longest = Math.min(...eligible.map(p => p.last_floor));
		let candidates = eligible.filter(p => p.last_floor === longest);
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
			let images = entry.images || [];
			let files = entry.files || [];

			// Shared text files go inside the message, each wrapped and named. Images are named in
			// the message, then each follows with a label, as the vision docs suggest, so everyone
			// can refer to "Image 2" later.

			let body = entry.text ? [entry.text] : [];
			for (let f of files) {
				body.push(`<file name="${f.name}">\n${f.text}\n</file>`);
			}
			if (images.length > 0) {
				body.push(`[shared ${images.length === 1 ? "an image" : "images"}: ${images.map(im => `Image ${im.number}`).join(", ")}]`);
			}
			let message = `<message from="${this.cfg.host_name} (host)">\n${body.join("\n")}\n</message>`;
			if (images.length === 0) {
				return message;
			}
			let blocks = [{type: "text", text: message}];
			for (let im of images) {
				blocks.push({type: "text", text: `Image ${im.number}, shared by ${this.cfg.host_name}:`});
				blocks.push({type: "image", source: {type: "base64", media_type: im.media_type, data: im.data}});
			}
			return blocks;
		}
		if (entry.kind === "turn" && entry.author !== me.name) {
			if (entry.text) {
				return `<message from="${entry.author}">\n${entry.text}\n</message>`;
			}

			// Others need to know a turn happened, or they may wait for someone who has
			// already passed (as happened when the host asked one model to start).

			if (entry.action === "pass") {
				return `<notice>${entry.author} passed.</notice>`;
			}
			if (entry.action === "silent") {
				return `<notice>${entry.author} had the floor but said nothing.</notice>`;
			}
		}
		if (entry.kind === "tool_op" && entry.announce && entry.author !== me.name) {
			return `<notice>${entry.announce}</notice>`;
		}
		return "";								// Errors, warnings and private tool use stay invisible to the models.
	},

	build_view: function(me) {

		let messages = [];
		let parts = [];							// Content blocks; neighbouring text is merged on flush.
		let tool_results = [];

		let flush = () => {
			let content = tool_results.map(tool_result_block);
			for (let block of parts) {
				let last = content[content.length - 1];
				if (block.type === "text" && last && last.type === "text") {
					last.text += "\n\n" + block.text;
				} else {
					content.push(Object.assign({}, block));
				}
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
				let r = this.render_for(entry, me);
				if (Array.isArray(r)) {
					parts.push(...r);
				} else if (r) {
					parts.push({type: "text", text: r});
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

	note_floor: function(p) {
		p.last_floor = ++this.floor_count;
	},

	on_error: function(p, error, partial) {
		this.note_floor(p);
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
			p.cost_known = false;
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
			tool_ops: [],
			pass: false,
			sit_out: false,
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

		let actor = {key: p.name, stamp: `${p.name} (${p.cfg.full_name}, ${p.cfg.model})`};
		let used_tools = false;

		for (let t of tool_uses) {
			if (this.closed) {						// Closed mid-step: run nothing more.
				step.tool_results.push({tool_use_id: t.id, content: "Not run: the room has closed.", is_error: true});
				continue;
			}
			if (t.name === "pass") {
				step.pass = true;
				step.tool_results.push({tool_use_id: t.id, content: turn_text.trim() ? "Your message was posted." : "You passed."});
			} else if (t.name === "sit_out") {
				step.sit_out = true;
				step.tool_results.push({tool_use_id: t.id, content: `You're sitting out${turn_text.trim() ? ", and your message was posted" : ""}. You won't get the floor until someone @mentions you${this.cfg.host_present ? ` (or ${this.cfg.host_name} gives it to you)` : ""}, and then you'll see everything that happened meanwhile.`});
			} else if (t.name === "leave_room") {
				step.leave = t;
				step.tool_results.push({tool_use_id: t.id, content: "You have left the room."});
			} else if (ROOM_TOOL_NAMES.includes(t.name)) {
				used_tools = true;
				let r = t.name === "note_to_host" ? this.take_host_note(p, t.input) : this.status_for(p);
				step.tool_ops.push({tool: t.name, summary: r.summary, is_error: r.is_error});
				step.tool_results.push({tool_use_id: t.id, content: r.content, is_error: r.is_error});
				if (r.entry) {
					this.append(r.entry);			// A note for the host, logged as it's left.
				} else {
					this.append({kind: "tool_op", author: p.name, tool: t.name, summary: r.summary, is_error: r.is_error, announce: ""});
				}
			} else if ((FILE_TOOL_NAMES.includes(t.name) && p.storage) || UTILITY_TOOL_NAMES.includes(t.name)) {
				used_tools = true;
				let r;
				try {
					r = UTILITY_TOOL_NAMES.includes(t.name)
						? run_utility_tool(t, p.name, {envelopes: this.envelopes})
						: run_file_tool({private: p.storage, shared: this.shared_storage}, t, actor);
				} catch (error) {						// These shouldn't throw, but a tool call must never end the session.
					r = {content: "Error: the tool failed unexpectedly.", is_error: true, summary: `tool ${t.name} failed unexpectedly`};
				}
				step.tool_ops.push({tool: t.name, summary: r.summary, is_error: r.is_error});
				step.tool_results.push({tool_use_id: t.id, content: r.content, is_error: r.is_error});

				// Logged now, not at the end of the turn, so the transcript has it even if the
				// session dies during a later step. The step is complete before listeners run.
				// "announce" (dice rolls, changes to shared files) is shown to the other models.

				this.append({kind: "tool_op", author: p.name, tool: t.name, summary: r.summary, is_error: r.is_error, announce: r.announce || ""});
			} else {
				step.tool_results.push({tool_use_id: t.id, content: `Unknown tool: ${t.name}`, is_error: true});
			}
		}

		step.ends_turn = !(used_tools && step.stop_reason === "tool_use" && !step.pass && !step.sit_out && !step.leave);
		return step;
	},

	// note_to_host: a note only the host sees, logged as a "host_note" entry (never shown to the
	// models). Returns {content, is_error, summary, entry}.

	take_host_note: function(p, input) {
		let host = this.cfg.host_name;
		let note = typeof input?.note === "string" ? input.note.trim() : "";
		if (!note) {
			return {content: "Error: the note was empty. Write it in \"note\".", is_error: true, summary: "tried to leave an empty note"};
		}
		if (note.length > MAX_NOTE) {
			return {content: `Error: the note is too long (${note.length} characters; at most ${MAX_NOTE}).`, is_error: true, summary: "tried to leave an overlong note"};
		}
		let reply = input?.reply === "when you can" ? "when you can" : "not needed";
		let when = this.cfg.host_present
			? `${host} may not read it straight away.`
			: `${host} isn't watching this session live, so will read it afterwards.`;
		let answer = reply === "when you can" && this.cfg.host_present
			? ` If ${host} replies, it will be an ordinary message in the room.`
			: "";
		return {
			content: `Your note is on its way to ${host}. The other models aren't told, and the room carries on. ${when}${answer}`,
			is_error: false,
			summary: `left a note for ${host}`,
			entry: {kind: "host_note", author: p.name, text: note, reply},
		};
	},

	// room_status: what's left of the session, for the model who asks.

	status_for: function(p) {
		let lines = [];
		if (this.closing) {
			lines.push("The room is closing: this is the farewell round.");
		}
		let turns = `${this.turn_count} model turn${this.turn_count === 1 ? "" : "s"} completed so far`;
		lines.push(this.cfg.max_turns > 0
			? `Turns: ${turns}, of ${this.cfg.max_turns}. The room starts closing at ${this.cfg.max_turns}.`
			: `Turns: ${turns}. There's no turn limit.`);
		if (this.cfg.budget > 0) {
			let used = Math.min(100, Math.round(100 * this.total_cost / this.cfg.budget));
			lines.push(`Budget: about ${used}% used${this.cost_known ? "" : " (not counting some models whose prices are unknown)"}. The room starts closing at 90%.`);
		} else {
			lines.push("Budget: there's no spending limit.");
		}
		let opened = this.log.length > 0 ? Date.parse(this.log[0].time) : Date.now();
		let minutes = Math.max(0, Math.round((Date.now() - opened) / 60000));
		lines.push(`Open for: ${minutes} minute${minutes === 1 ? "" : "s"}. The time now is ${clock_time(new Date())}.`);
		let sitting = this.present_models().filter(m => m.sitting_out).map(m => m.name);
		if (sitting.length > 0) {
			lines.push(`Sitting out until mentioned: ${sitting.join(", ")}.`);
		}
		lines.push(`Here: ${this.present_models().map(m => m.name).join(", ")}, and ${this.cfg.host_name} (the host, ${this.cfg.host_present ? "present, though they may not read everything as it happens" : "not watching live"}).`);
		return {content: lines.join("\n"), is_error: false, summary: "checked the room status"};
	},

	record_turn: function(p, steps) {

		p.turns++;
		this.turn_count++;
		this.note_floor(p);

		let text = steps.map(s => s.text.trim()).filter(Boolean).join("\n\n");
		let leave = steps.map(s => s.leave).find(Boolean) || null;
		let pass = steps.some(s => s.pass);
		let sit_out = !leave && steps.some(s => s.sit_out);
		let action = leave ? "leave" : (text ? "speak" : (sit_out ? "sit_out" : (pass ? "pass" : "silent")));
		let note = typeof leave?.input?.note_to_host === "string" ? leave.input.note_to_host.trim() : "";
		let costs = steps.map(s => s.cost);
		let last = steps[steps.length - 1];

		this.append({
			kind: "turn",
			author: p.name,
			action: action,
			text: text,
			thinking: steps.flatMap(s => s.thinking),
			tool_ops: steps.flatMap(s => s.tool_ops),
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

		if (sit_out) {
			p.sitting_out = true;
			this.floor_queue = this.floor_queue.filter(n => n !== p.name);
			this.notice(`${p.name} is sitting out, and won't take turns until someone @mentions them.`);
		}

		if (action === "leave") {
			p.present = false;
			this.floor_queue = this.floor_queue.filter(n => n !== p.name);

			// A secret can't leave the game with its keeper: their sealed envelopes open for all.
			// The others stay closed, since anyone can open those when the time comes (opening a
			// bid early, before everyone's are in, would spoil the round).

			for (let e of this.envelopes.unopened_sealed(p.name)) {
				e.opened = true;
				this.append({
					kind: "tool_op", author: p.name, tool: "open_envelope", is_error: false,
					summary: `left with a sealed envelope unopened, so the room opened ${describe_opened(e)}`,
					announce: `${p.name} is leaving, so the room has opened ${describe_opened(e)}`,
				});
			}
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
			this.reveal_unopened_to_host();
			this.notice("The room is now closed.");
			this.finish(reason);
		}
	},

	// Envelopes nobody opened go into the host's transcript as the room closes. The models
	// never see these entries (no announcement), since the room is ending anyway.

	reveal_unopened_to_host: function() {
		for (let e of this.envelopes.unopened()) {
			e.opened = true;
			this.append({kind: "tool_op", author: e.author, tool: "envelope", is_error: false, announce: "",
				summary: `never opened ${describe_opened(e)}`});
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

	// images: prepared images from src/images.js ({media_type, data, width, height, tokens, source}).

	// Returns false if nothing was queued (empty, closed, or over the image limit).

	// files: prepared text files from src/textfile.js ({name, text, lines, tokens}).

	host_say: function(text, images = [], files = []) {
		text = String(text ?? "").trim();
		images = (Array.isArray(images) ? images : [images]).filter(Boolean);
		files = (Array.isArray(files) ? files : [files]).filter(Boolean);
		if ((!text && images.length === 0 && files.length === 0) || this.closed) {
			return false;
		}
		if (this.images_left() < images.length) {
			return false;
		}
		this.pending_host.push({text, images, files});	// Applied between turns, so no model's history shows a
		this.wake();							// message it didn't actually see before replying.
		return true;
	},

	images_left: function() {
		let pending = this.pending_host.reduce((n, m) => n + (m.images || []).length, 0);
		return MAX_IMAGES - this.image_count - pending;
	},

	apply_pending_host_messages: function() {
		while (this.pending_host.length > 0) {
			let m = this.pending_host.shift();
			let images = (m.images || []).map(im => Object.assign({}, im, {number: ++this.image_count}));
			let files = (m.files || []).map(f => ({name: f.name, text: f.text, lines: f.lines, tokens: f.tokens}));
			let entry = {kind: "host", text: m.text};
			if (images.length) {
				entry.images = images;
			}
			if (files.length) {
				entry.files = files;
			}
			this.append(entry);
			this.on_message(this.cfg.host_name, m.text);		// Only the message itself can @mention, not a file's contents.
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
			this.quiet = false;					// Nudge: everyone may speak again, including the last speaker
			this.passed.clear();				// and anyone sitting out.
			for (let p of this.participants) {
				p.sitting_out = false;
			}
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
		p.sitting_out = false;
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
		this.reveal_unopened_to_host();
		this.notice("The room was closed by the host.");
		this.finish("quit");
	},
};

// ------------------------------------------------------------------------------------------------

// "native" is a non-Anthropic backend's own form of the block (a Gemini step, say), which that
// backend replays verbatim; it never reaches any other backend, since a participant's own turns
// all come from the same one.

function clean_block(b) {
	let cleaned;
	if (b.type === "text") {
		if (!b.text.trim()) {
			return null;
		}
		cleaned = {type: "text", text: b.text};
	} else if (b.type === "tool_use") {
		cleaned = {type: "tool_use", id: b.id, name: b.name, input: b.input ?? {}};
	} else {
		return b;								// thinking / redacted_thinking: must be passed back unchanged.
	}
	if (b.native) {
		cleaned.native = b.native;
	}
	return cleaned;
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

module.exports = {new_room, TOOLS, MAX_IMAGES};
