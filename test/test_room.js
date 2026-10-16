"use strict";

// Tests the room against a scripted fake backend. No API key or network needed.
// Every request the room makes is checked against the Messages API's structural rules.

const assert = require("assert");
const path = require("path");
const {new_room} = require("../src/room");
const {build_system_prompt} = require("../src/prompt");
const pricing = require("../src/pricing");

let tool_id_counter = 0;

function usage(input = 1000, output = 100) {
	return {input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
}

function speak(text, extra_before = []) {
	return {content: extra_before.concat([{type: "text", text, citations: null}]), stop_reason: "end_turn", usage: usage()};
}

function pass() {
	return {content: [{type: "tool_use", id: `toolu_${++tool_id_counter}`, name: "pass", input: {}}], stop_reason: "tool_use", usage: usage()};
}

function leave(goodbye, note) {
	let content = [];
	if (goodbye) {
		content.push({type: "text", text: goodbye, citations: null});
	}
	content.push({type: "tool_use", id: `toolu_${++tool_id_counter}`, name: "leave_room", input: note ? {note_to_host: note} : {}});
	return {content, stop_reason: "tool_use", usage: usage()};
}

function make_cfg(overrides = {}) {
	let participants = ["Opus", "Sonnet", "Haiku"].map(name => ({
		name: name,
		model: `claude-${name.toLowerCase()}-5-5`,
		full_name: `Claude ${name} 5.5`,
		company: "Anthropic",
		max_tokens: 16000,
		effort: "",
		price_tiers: pricing.tiers_for(`claude-${name.toLowerCase()}-5-5`, null),
	}));
	return Object.assign({
		host_name: "Host",
		host_present: false,
		show_thinking: false,
		opening_message: "",
		first_speaker: "",
		floor_randomness: 0,
		max_turns: 0,
		budget: 0,
		farewell_round: true,
		cache_ttl: "5m",
		participants: participants,
	}, overrides);
}

// Checks one request against the rules the API enforces.

function validate_request(req) {
	let m = req.messages;
	assert(m.length > 0, "messages must not be empty");
	assert.strictEqual(m[0].role, "user", "first message must be from the user");
	assert.strictEqual(m[m.length - 1].role, "user", "last message must be from the user (no prefill)");
	for (let i = 0; i < m.length; i++) {
		assert(Array.isArray(m[i].content) && m[i].content.length > 0, `message ${i} has empty content`);
		if (i > 0) {
			assert.notStrictEqual(m[i].role, m[i - 1].role, `messages ${i - 1} and ${i} have the same role`);
		}
		for (let b of m[i].content) {
			if (b.type === "text") {
				assert(b.text.trim().length > 0, `message ${i} has an empty text block`);
			}
		}
		if (m[i].role === "assistant") {
			let ids = m[i].content.filter(b => b.type === "tool_use").map(b => b.id);
			if (ids.length > 0) {
				let next = m[i + 1];
				assert(next && next.role === "user", "tool_use must be followed by a user message");
				let leading = next.content.slice(0, ids.length);
				assert(leading.every(b => b.type === "tool_result"), "tool_results must come first in the next user message");
				assert.deepStrictEqual(leading.map(b => b.tool_use_id), ids, "tool_result ids must match the tool_use ids");
			}
		}
	}
	assert.strictEqual(typeof req.system, "string");
	let names = req.tools.map(t => t.name);
	assert.deepStrictEqual(names.slice(0, 10), ["pass", "leave_room", "sit_out", "note_to_host", "room_status", "roll_dice", "shuffle", "calculate", "create_envelope", "open_envelope"]);
	assert.strictEqual(new Set(names).size, names.length, "tool names are unique");
	assert(names.length === 10 || names.length === 17, "either no file tools or all seven");
}

// A fake backend. script(name, req, n) returns a response (or throws). Records all requests.

function fake_backend(script, opts = {}) {
	let calls = [];
	return {
		calls: calls,
		send: async function(req) {
			validate_request(req);
			let name = req.participant.name;
			let n = calls.filter(c => c.name === name).length;
			calls.push({name, req: JSON.parse(JSON.stringify(req, (k, v) => (k === "signal" || k === "on_text") ? undefined : v))});
			if (opts.before_reply) {
				await opts.before_reply(name, req, n);
			}
			return script(name, req, n);
		},
		is_abort_error: (e) => e?.name === "AbortError",
	};
}

function turns(room) {
	return room.log.filter(e => e.kind === "turn");
}

function last_user_text(req) {
	let last = req.messages[req.messages.length - 1];
	return last.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// Builds a config's "models" object from a list of {name, ...settings}.

function as_models(list) {
	return Object.fromEntries(list.map(m => {
		let settings = Object.assign({}, m);
		delete settings.name;
		return [m.name, settings];
	}));
}

let tests = [];
function test(name, fn) {
	tests.push({name, fn});
}

// ------------------------------------------------------------------------------------------------

test("rotation goes to whoever has been quiet longest, then a farewell round", async () => {
	let backend = fake_backend((name, req, n) => speak(`${name} message ${n}`));
	let room = new_room(make_cfg({max_turns: 6}), backend, {template: "You are {{name}}.", random: () => 0});
	await room.run();
	let order = turns(room).map(t => t.author);
	assert.deepStrictEqual(order.slice(0, 6), ["Opus", "Sonnet", "Haiku", "Opus", "Sonnet", "Haiku"]);
	assert.strictEqual(order.length, 9, "6 turns plus 3 farewells");
	assert(turns(room).slice(6).every(t => t.closing), "last 3 turns are farewells");
	assert(room.log.some(e => e.kind === "notice" && e.text.includes("turn limit")));
	assert.strictEqual(room.log[room.log.length - 1].text, "The room is now closed.");
	assert(room.closed);
});

test("a model sees others' messages and passes, and its own turns as assistant messages", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Sonnet") return pass();
		return speak(`${name} says hi ${n}`);
	});
	let room = new_room(make_cfg({max_turns: 6, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let opus_second = backend.calls.filter(c => c.name === "Opus")[1].req;
	let roles = opus_second.messages.map(m => m.role);
	assert.deepStrictEqual(roles, ["user", "assistant", "user"]);
	assert.strictEqual(opus_second.messages[1].content[0].text, "Opus says hi 0");
	let latest = last_user_text(opus_second);
	assert(latest.includes("<message from=\"Haiku\">"), "Opus sees Haiku's message");
	assert(latest.includes("<notice>Sonnet passed.</notice>"), "Opus is told Sonnet passed");
	assert(latest.indexOf("Sonnet passed") < latest.indexOf("<message from=\"Haiku\">"), "in the order it happened");
	let sonnet_second = backend.calls.filter(c => c.name === "Sonnet")[1].req;
	let after_pass = sonnet_second.messages[sonnet_second.messages.length - 1].content;
	assert.strictEqual(after_pass[0].type, "tool_result", "Sonnet's pass gets a tool_result");
	assert.strictEqual(after_pass[0].content, "You passed.");
});

test("when the model asked to start passes, the others are told it already went", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Haiku" && n === 0) return pass();
		return speak(`${name} ${n}`);
	});
	let cfg = make_cfg({max_turns: 2, farewell_round: false, opening_message: "Hello all. @Haiku, would you start?"});
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	await room.run();
	let next = backend.calls[1];
	assert.notStrictEqual(next.name, "Haiku");
	let seen = last_user_text(next.req);
	assert(seen.includes("@Haiku, would you start?"));
	assert(seen.includes("<notice>Haiku passed.</notice>"), "the next model knows Haiku's turn already happened");
});

test("a model that passes isn't handed the floor again after every message", async () => {
	// Argon's report: Sonnet passed before ever speaking, so it stayed the "quietest" and was
	// picked after every single message.
	let backend = fake_backend((name, req, n) => name === "Sonnet" ? pass() : speak(`${name} ${n}`));
	let room = new_room(make_cfg({max_turns: 10, farewell_round: false}), backend, {template: "x", random: () => 0});
	room.participants.push(Object.assign({}, room.participants[2], {name: "Luna", turns: 0, last_spoke: -1, last_floor: -1, present: true}));
	await room.run();
	let order = turns(room).map(e => e.author);
	let sonnet = order.map((a, i) => a === "Sonnet" ? i : -1).filter(i => i >= 0);
	for (let i = 1; i < sonnet.length; i++) {
		assert(sonnet[i] - sonnet[i - 1] >= 3, `Sonnet should wait for the others between turns: ${order.join(", ")}`);
	}
	assert.deepStrictEqual(order.slice(0, 4).sort(), ["Haiku", "Luna", "Opus", "Sonnet"], "everyone gets a turn before anyone gets a second");
});

test("@mentions give the floor to the mentioned model next", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("What do you think, @haiku?");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({max_turns: 3, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	assert.deepStrictEqual(turns(room).map(t => t.author), ["Opus", "Haiku", "Sonnet"]);
});

test("the room goes quiet when everyone else passes, and closes if no host", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("That's all I had.");
		if (req.messages.some(m => m.content.some(b => b.type === "text" && b.text.includes("closing")))) {
			return speak(`Goodbye from ${name}`);
		}
		return pass();
	});
	let room = new_room(make_cfg(), backend, {template: "x", random: () => 0});
	await room.run();
	let t = turns(room);
	assert.deepStrictEqual(t.slice(0, 3).map(e => [e.author, e.action]), [["Opus", "speak"], ["Sonnet", "pass"], ["Haiku", "pass"]]);
	assert(room.log.some(e => e.kind === "notice" && e.text.includes("gone quiet")));
	assert.strictEqual(t.filter(e => e.closing).length, 3);
	assert(room.closed);
});

test("with a host present, going quiet waits; a host message wakes the room", async () => {
	let backend = fake_backend((name, req, n) => {
		if (last_user_text(req).includes("Host (host)")) return speak(`${name} answers the host`);
		if (name === "Opus" && n === 0) return speak("Hello all.");
		return pass();
	});
	let room = new_room(make_cfg({host_present: true, farewell_round: false}), backend, {template: "x", random: () => 0});
	let quiet_seen = new Promise(resolve => room.on("state", s => s.quiet && resolve()));
	let done = room.run();
	await quiet_seen;
	assert.strictEqual(turns(room).length, 3);
	room.host_say("@Sonnet, anything on your mind?");
	await new Promise(r => setTimeout(r, 20));
	assert.strictEqual(turns(room)[3].author, "Sonnet", "the mentioned model answers the host");
	room.host_quit();
	await done;
	assert(room.closed);
});

test("leaving: goodbye is posted, others are told, and the leaver is never asked again", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Sonnet" && n === 0) return leave("I'll head off now, thanks both.", "Just wanted some quiet.");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({max_turns: 6, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let t = turns(room);
	assert.strictEqual(t[1].action, "leave");
	assert.strictEqual(t[1].note_to_host, "Just wanted some quiet.");
	assert(!t.slice(2).some(e => e.author === "Sonnet"));
	let haiku_first = backend.calls.find(c => c.name === "Haiku").req;
	let seen = last_user_text(haiku_first);
	assert(seen.includes("I'll head off now"), "Haiku sees the goodbye");
	assert(seen.includes("<notice>Sonnet has left the room.</notice>"), "Haiku is told Sonnet left");
	assert(!seen.includes("Just wanted some quiet"), "the note to host stays private");
});

test("with no host, the room closes when only one model is left", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name !== "Opus" && n === 0) return leave(`Bye from ${name}`);
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	assert(room.closed);
	assert.strictEqual(room.present_models().length, 1);
});

test("thinking blocks are replayed exactly as received", async () => {
	let thinking = {type: "thinking", thinking: "", signature: "sig_abc123"};
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("First.", [thinking]);
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({max_turns: 4, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let opus_second = backend.calls.filter(c => c.name === "Opus")[1].req;
	assert.deepStrictEqual(opus_second.messages[1].content[0], thinking);
	assert.deepStrictEqual(opus_second.messages[1].content[1], {type: "text", text: "First."}, "null citations stripped from text");
});

test("a reply cut off at max_tokens keeps only its text", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) {
			return {
				content: [
					{type: "thinking", thinking: "", signature: "s"},
					{type: "text", text: "I was saying that", citations: null},
					{type: "tool_use", id: "toolu_partial", name: "pass", input: {}},
				],
				stop_reason: "max_tokens",
				usage: usage(),
			};
		}
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({max_turns: 4, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let opus_second = backend.calls.filter(c => c.name === "Opus")[1].req;
	assert.deepStrictEqual(opus_second.messages[1].content, [{type: "text", text: "I was saying that"}]);
});

test("a host message sent mid-turn is held until the turn finishes", async () => {
	let room;
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`), {
		before_reply: async (name, req, n) => {
			if (name === "Opus" && n === 0) {
				room.host_say("Hello everyone!");
				await new Promise(r => setTimeout(r, 5));
			}
		},
	});
	room = new_room(make_cfg({host_present: true, max_turns: 4, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let kinds = room.log.map(e => e.kind === "turn" ? `turn:${e.author}` : e.kind);
	assert.deepStrictEqual(kinds.slice(0, 3), ["notice", "turn:Opus", "host"], "host message lands after Opus's turn");
	let opus_second = backend.calls.filter(c => c.name === "Opus")[1].req;
	let roles = opus_second.messages.map(m => m.role);
	assert.deepStrictEqual(roles, ["user", "assistant", "user"], "Opus's history shows the host message after its own reply");
});

test("budget: the room starts closing at 90%, and farewells stop at 100%", async () => {
	// Opus at $4/$20 per MTok: 1000 in + 100 out = $0.006 per turn.
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
	let cfg = make_cfg({budget: 0.02});
	cfg.participants = cfg.participants.slice(0, 1).concat(cfg.participants.slice(0, 1).map(p => Object.assign({}, p, {name: "Opus2"})));
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	await room.run();
	assert(room.log.some(e => e.kind === "notice" && e.text.includes("budget")));
	assert(room.total_cost <= 0.02 + 0.006 + 1e-9, `spent ${room.total_cost}`);
	assert(room.total_cost >= 0.018);
});

test("errors move the floor on; three in a row pause the room when a host is present", async () => {
	let backend = fake_backend(() => {
		throw new Error("overloaded");
	});
	let room = new_room(make_cfg({host_present: true}), backend, {template: "x", random: () => 0});
	let paused = new Promise(resolve => room.on("state", s => s.paused && resolve()));
	let done = room.run();
	await paused;
	assert.strictEqual(room.log.filter(e => e.kind === "error").length, 4, "3 errors plus the pause message");
	assert.strictEqual(turns(room).length, 0);
	room.host_quit();
	await done;
});

test("/end gives a farewell round; /quit aborts at once", async () => {
	let room;
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`), {
		before_reply: async (name, req, n) => {
			if (name === "Haiku" && n === 0) room.host_end();
		},
	});
	room = new_room(make_cfg({host_present: true}), backend, {template: "x", random: () => 0});
	await room.run();
	let t = turns(room);
	assert.strictEqual(t.length, 6, "3 turns, then 3 farewells");
	assert(room.log.some(e => e.kind === "notice" && e.text.includes("Host is closing it")));
});

test("system prompt template fills in every placeholder", () => {
	let cfg = make_cfg({system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	let s = build_system_prompt(cfg, cfg.participants[1]);
	assert(!s.includes("{{"), "no unfilled placeholders");
	assert(s.includes("You are Claude Sonnet 5.5."));
	assert(s.includes("- Sonnet: Claude Sonnet 5.5, made by Anthropic (this is you)"));
	assert(s.includes("isn't shown to anyone"));
	cfg.show_thinking = true;
	assert(build_system_prompt(cfg, cfg.participants[1]).includes("Summaries of your private reasoning are saved"));
	assert(!s.includes("@Host: the room will wait"), "no host-floor note when the host is absent");
	assert(s.includes("Host isn't watching this session live") && !s.includes("may join in"));
	cfg.host_present = true;
	let present = build_system_prompt(cfg, cfg.participants[1]);
	assert(present.includes("The same goes for @Host: the room will wait for their reply, so only write @Host when you want that"));
	assert(present.includes("Host may join in now and then") && !present.includes("isn't watching"));
	assert(present.includes("Even while here, Host may not read everything as it happens"));
});

async function until(predicate, ms = 1000) {
	let start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) {
			throw new Error("timed out waiting");
		}
		await new Promise(r => setTimeout(r, 2));
	}
}

test("@host hands the floor to the host, and the room waits without asking anyone else", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("Over to you, @host. Where should we go next?");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({host_present: true, max_turns: 3, farewell_round: false}), backend, {template: "x", random: () => 0});
	let done = room.run();
	await until(() => room.awaiting_host === "Opus");
	await new Promise(r => setTimeout(r, 20));
	assert.strictEqual(backend.calls.length, 1, "nobody else was asked while the floor was with the host");
	room.host_say("Somewhere warm. @Haiku, you start.");
	await done;
	assert.strictEqual(turns(room)[1].author, "Haiku");
	assert.strictEqual(room.awaiting_host, null);
});

test("/resume declines a floor handed to the host, and the others carry on", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("@Host, any thoughts?");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({host_present: true, max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
	let done = room.run();
	await until(() => room.awaiting_host === "Opus");
	room.host_resume();
	await done;
	assert.notStrictEqual(turns(room)[1].author, "Opus", "the model that asked doesn't get the floor straight back");
	assert(!room.log.some(e => e.kind === "host"));
});

test("@host alongside a model, or with no host present, doesn't stop the room", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("@Host and @Haiku, what do you both think?");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({host_present: true, max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	assert.deepStrictEqual(turns(room).map(t => t.author), ["Opus", "Haiku"]);

	backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return speak("What do you think, @Host?");
		return speak(`${name} ${n}`);
	});
	room = new_room(make_cfg({max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	assert.strictEqual(turns(room).length, 2, "unattended: the mention is ignored");
});

test("pricing: cache reads and Haiku's long-prompt tier", () => {
	let opus = pricing.tiers_for("claude-opus-5-5", null);
	let c = pricing.cost_of_usage(opus, {input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0}, "5m");
	assert.strictEqual(c.toFixed(2), "24.20");
	let haiku = pricing.tiers_for("claude-haiku-5-5", null);
	let short = pricing.cost_of_usage(haiku, {input_tokens: 100000, output_tokens: 0}, "5m");
	let long = pricing.cost_of_usage(haiku, {input_tokens: 100001, output_tokens: 0}, "5m");
	assert.strictEqual(short.toFixed(4), "0.0100");
	assert.strictEqual(long.toFixed(4), "0.0500");
});

test("random words: distinct, from the list, and phrased correctly", () => {
	let {load_words, pick_words, word_seed_message} = require("../src/words");
	let list = load_words(path.join(__dirname, "..", "words.txt"));
	assert(list.length > 2000);
	for (let trial = 0; trial < 200; trial++) {
		let picked = pick_words(list, 5);
		assert.strictEqual(new Set(picked).size, 5);
		assert(picked.every(w => list.includes(w)));
	}
	assert.strictEqual(pick_words(["a", "b"], 5).length, 2, "never more than the list holds");
	assert.strictEqual(word_seed_message(["apricity", "petard", "ablaut"]),
		"Here are 3 randomly selected words, as food for thought if you'd like some: apricity, petard and ablaut. Use them or ignore them, as you like.");
	assert.strictEqual(word_seed_message(["apricity"]),
		"Here's a randomly selected word, as food for thought if you'd like some: apricity. Use it or ignore it, as you like.");
});

// ------------------------------------------------------------------------------------------------
// Private folders.

const fs = require("fs");
const os = require("os");
const {new_storage, run_file_tool, LIMITS} = require("../src/storage");

function temp_dir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "discourse-test-"));
}

function tool(name, input) {
	return {type: "tool_use", id: `toolu_${++tool_id_counter}`, name, input};
}

function file_step(...tool_uses) {
	return {content: tool_uses, stop_reason: "tool_use", usage: usage()};
}

test("storage: bad filenames are refused and nothing escapes the folder", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	let outside_before = fs.readdirSync(root).sort();
	let bad = ["../x.txt", "../../etc/passwd", "a/b.txt", "a\\b.txt", "/tmp/x", ".meta.json", ".hidden", "", ".", "..",
		"x".repeat(65), "con", "CON.txt", "nul", "com1.md", "file.", "spaced name.txt", "tab\tname", "null\0byte", "ünïcode.txt"];
	for (let name of bad) {
		assert.throws(() => st.write(name, "hi", "test"), undefined, `write should refuse ${JSON.stringify(name)}`);
		assert.throws(() => st.read(name), undefined, `read should refuse ${JSON.stringify(name)}`);
		assert.throws(() => st.delete(name), undefined, `delete should refuse ${JSON.stringify(name)}`);
	}
	assert.throws(() => st.write(123, "hi", "test"));
	assert.deepStrictEqual(fs.readdirSync(root).sort(), outside_before, "nothing new outside the folder");
	assert.deepStrictEqual(st.files(), [], "nothing written inside either");
});

// Creating file symlinks needs extra privileges on Windows. Where that's refused, the symlink
// checks are skipped (and reported), rather than failing the suite.

function try_symlink(target, where, type) {
	try {
		fs.symlinkSync(target, where, type);
		return true;
	} catch (error) {
		if (error.code === "EPERM" || error.code === "EACCES") {
			return false;
		}
		throw error;
	}
}

test("storage: symlinks, hard links, subfolders and a linked folder are refused", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	let secret = path.join(root, "secret.txt");
	fs.writeFileSync(secret, "outside");
	let skipped = [];

	// Hard links work without privileges, on Windows (NTFS) too.

	fs.linkSync(secret, path.join(st.folder, "hard.txt"));
	assert.throws(() => st.read("hard.txt"), /isn't a plain file/);
	assert.throws(() => st.write("hard.txt", "overwrite", "t"), /isn't a plain file/);
	assert.throws(() => st.edit("hard.txt", "outside", "x", "t"), /isn't a plain file/);
	assert.throws(() => st.delete("hard.txt"), /isn't a plain file/);

	if (try_symlink(secret, path.join(st.folder, "link.txt"), "file")) {
		assert.throws(() => st.read("link.txt"), /isn't a plain file/);
		assert.throws(() => st.write("link.txt", "overwrite", "t"), /isn't a plain file/);
		assert.throws(() => st.edit("link.txt", "outside", "x", "t"));
		assert.throws(() => st.delete("link.txt"));
	} else {
		skipped.push("file symlinks");
	}

	if (try_symlink(path.join(root, "not-there.txt"), path.join(st.folder, "dangling.txt"), "file")) {
		assert.throws(() => st.write("dangling.txt", "create", "t"), /isn't a plain file/);
		assert(!fs.existsSync(path.join(root, "not-there.txt")), "the dangling target wasn't created");
	} else {
		skipped.push("dangling symlinks");
	}

	fs.mkdirSync(path.join(st.folder, "sub"));
	assert.throws(() => st.write("sub", "x", "t"));
	assert.strictEqual(fs.readFileSync(secret, "utf8"), "outside", "the outside file is untouched");
	assert.deepStrictEqual(st.files().map(f => f.name), [], "links and folders aren't listed");

	// "junction" makes a directory link on Windows without privileges; elsewhere it's ignored.

	if (try_symlink(root, path.join(root, "Sonnet"), "junction")) {
		assert.throws(() => new_storage(root, "Sonnet"), /not a plain directory/);
	} else {
		skipped.push("linked folders");
	}

	return skipped.length ? `skipped, no permission: ${skipped.join(", ")}` : "";
});

test("storage: filenames are case-insensitive, for quotas and metadata alike", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("Notes.txt", "first", "Claude Opus 5.5 (claude-opus-5-5)");
	let r = st.write("notes.txt", "second", "Claude Opus 6 (claude-opus-6)");
	assert.strictEqual(r.name, "Notes.txt", "the existing spelling is kept");
	assert.strictEqual(r.existed, true);
	assert.deepStrictEqual(st.files().map(f => f.name), ["Notes.txt"], "one file, not two");
	assert.strictEqual(st.read("NOTES.TXT").text, "second");
	assert.deepStrictEqual(Object.keys(st.read_meta()), ["Notes.txt"], "one metadata entry");
	assert(st.listing().includes("last written by Claude Opus 6"), "the listing shows the latest writer");

	let st2 = new_storage(temp_dir(), "Haiku");
	for (let i = 0; i < LIMITS.file_count; i++) {
		st2.write(`F${i}.txt`, "", "t");
	}
	st2.write("f0.txt", "a rewrite under another spelling is not a new file", "t");
	st2.edit("f0.TXT", "another", "a different", "t");
	st2.delete("f1.TXT");
	assert.strictEqual(st2.files().length, LIMITS.file_count - 1);
});

test("storage: a file called __proto__ keeps its metadata", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("__proto__", "hello", "Claude Opus 5.5 (claude-opus-5-5)");
	let meta = st.read_meta();
	assert(Object.hasOwn(meta, "__proto__"), "stored as an ordinary key");
	assert.strictEqual(meta["__proto__"].modified_by, "Claude Opus 5.5 (claude-opus-5-5)");
	assert(st.listing().includes("__proto__ (5 bytes"));
	assert(st.listing().includes("last written by Claude Opus 5.5"));
	assert(!("modified_by" in {}), "no prototype was polluted");
	st.delete("__proto__");
	assert(!Object.hasOwn(st.read_meta(), "__proto__"));
});

test("storage: an edit whose old_text matches in overlapping places is refused", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("a.txt", "aaa", "t");
	assert.throws(() => st.edit("a.txt", "aa", "b", "t"), /more than one place/);
	assert.strictEqual(st.read("a.txt").text, "aaa");
	st.write("b.txt", "abcabc", "t");
	assert.throws(() => st.edit("b.txt", "abc", "x", "t"), /more than one place/);
	st.edit("b.txt", "cab", "-", "t");
	assert.strictEqual(st.read("b.txt").text, "ab-c");
});

test("file tools: malformed input can't crash the dispatcher", () => {
	let st = new_storage(temp_dir(), "Opus");
	let evil = {toString: "x"};								// String(evil) throws a TypeError.
	let inputs = [
		{filename: evil},
		{filename: {toString() { throw new Error("boom"); }}},
		{filename: ["a.txt"]},
		{filename: 42},
		{filename: null},
		{filename: "ok.txt", content: evil},
		{filename: "ok.txt", old_text: evil, new_text: "x"},
	];
	for (let tool_name of ["read_file", "write_file", "edit_file", "delete_file"]) {
		for (let input of inputs) {
			let r = run_file_tool(st, {id: "t", name: tool_name, input}, "t");
			assert.strictEqual(r.is_error, true, `${tool_name} with ${Object.keys(input)} is an error, not a crash`);
			assert.strictEqual(typeof r.summary, "string");
		}
	}
	for (let input of ["a string", 7, null, undefined, [1, 2]]) {
		let r = run_file_tool(st, {id: "t", name: "read_file", input}, "t");
		assert.strictEqual(r.is_error, true);
	}
	assert.strictEqual(run_file_tool(st, {id: "t", name: {toString: "x"}, input: {}}, "t").is_error, true);
});

test("quitting mid-turn keeps the record of steps already taken", async () => {
	let root = temp_dir();
	let room;
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return file_step(tool("write_file", {filename: "notes.md", content: "kept"}));
		return speak(`${name} ${n}`);
	}, {
		before_reply: async (name, req, n) => {
			if (name === "Opus" && n === 1) {
				room.host_quit();							// Arrives while Opus's second step is in flight.
				let e = new Error("aborted");
				e.name = "AbortError";
				throw e;
			}
		},
	});
	let cfg = make_cfg({storage_dir: root, host_present: true, transcript_dir: temp_dir()});
	room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);

	// The CLI exits as soon as "closed" fires, so everything must be on record by then.

	let at_close = null;
	room.on("closed", () => {
		at_close = {
			turns: turns(room).length,
			turn_count: room.turn_count,
			md: fs.readFileSync(files.md_path, "utf8"),
		};
	});
	await room.run();

	assert.strictEqual(fs.readFileSync(path.join(root, "claude-opus-5-5", "notes.md"), "utf8"), "kept");
	assert.strictEqual(at_close.turns, 1, "the interrupted turn was logged before 'closed' fired");
	assert.strictEqual(at_close.turn_count, 1);
	assert.deepStrictEqual(turns(room)[0].tool_ops.map(o => o.summary), ["created notes.md (4 bytes)"]);
	let kinds = room.log.map(e => e.kind === "notice" ? e.text : e.kind);
	assert(kinds.indexOf("turn") < kinds.indexOf("The room was closed by the host."), "turn before the closing notice");
	let md = fs.readFileSync(files.md_path, "utf8");
	assert(md.indexOf("created notes.md") !== -1 && md.indexOf("created notes.md") < md.indexOf("Total cost"), "transcript has the file op before the summary");
	assert(md.includes("- Opus: 1 turns"), "the summary counts the turn");
	assert.strictEqual(turns(room).length, 1, "and it wasn't recorded twice");
});

test("a reply that arrives after /quit isn't acted on", async () => {
	let root = temp_dir();
	let room;
	let backend = fake_backend((name, req, n) => {
		return file_step(tool("write_file", {filename: "late.md", content: "should not exist"}));
	}, {
		before_reply: async (name, req, n) => {
			room.host_quit();							// The request still resolves normally afterwards.
		},
	});
	room = new_room(make_cfg({storage_dir: root, host_present: true}), backend, {template: "x", random: () => 0});
	await room.run();
	assert(!fs.existsSync(path.join(root, "claude-opus-5-5", "late.md")), "no file tool ran after the room closed");
	assert.strictEqual(turns(room).length, 0);
});

// Temporarily replaces fs.writeSync, to simulate short writes or a full disk.

function with_write_sync(fake, fn) {
	let real = fs.writeSync;
	fs.writeSync = (...args) => fake(real, ...args);
	try {
		return fn();
	} finally {
		fs.writeSync = real;
	}
}

function leftovers(st) {
	return fs.readdirSync(st.folder).filter(n => n.startsWith(".tmp-"));
}

test("storage: short writes are completed, not silently truncated", () => {
	let st = new_storage(temp_dir(), "Opus");
	let two_at_a_time = (real, fd, data, ...rest) => {				// Handles both writeSync signatures.
		if (typeof data === "string") {
			return real(fd, data.slice(0, 2), rest[0], rest[1]);
		}
		let [off, len, pos] = rest;
		return real(fd, data, off, Math.min(len, 2), pos);
	};
	let r = with_write_sync(two_at_a_time, () => run_file_tool(st, tool("write_file", {filename: "a.md", content: "replaced content!"}), "t"));
	assert.strictEqual(r.content, "Created a.md (17 bytes).");
	assert.strictEqual(st.read("a.md").text, "replaced content!");
	with_write_sync(two_at_a_time, () => st.write("a.md", "and again, in full", "t"));
	assert.strictEqual(st.read("a.md").text, "and again, in full");
	with_write_sync(two_at_a_time, () => st.edit("a.md", "again", "once more", "t"));
	assert.strictEqual(st.read("a.md").text, "and once more, in full");
	assert.deepStrictEqual(leftovers(st), []);
});

test("storage: a full disk never damages the original file", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("keep.md", "precious words", "t");
	let disk_full = () => {
		let e = new Error("ENOSPC: no space left on device");
		e.code = "ENOSPC";
		throw e;
	};
	let accepts_nothing = () => 0;

	for (let fake of [disk_full, accepts_nothing]) {
		let r = with_write_sync(fake, () => run_file_tool(st, tool("edit_file", {filename: "keep.md", old_text: "precious", new_text: "lost"}), "t"));
		assert.strictEqual(r.is_error, true);
		assert.strictEqual(st.read("keep.md").text, "precious words", "edit failure left the original intact");

		r = with_write_sync(fake, () => run_file_tool(st, tool("write_file", {filename: "keep.md", content: "overwritten", overwrite: true}), "t"));
		assert.strictEqual(r.is_error, true);
		assert.strictEqual(st.read("keep.md").text, "precious words", "rewrite failure left the original intact");

		r = with_write_sync(fake, () => run_file_tool(st, tool("write_file", {filename: "new.md", content: "half"}), "t"));
		assert.strictEqual(r.is_error, true);
		assert(!st.exists("new.md"), "a failed new file isn't left half written");

		assert.deepStrictEqual(leftovers(st), [], "no temporary files left behind");
	}
	assert.deepStrictEqual(st.files().map(f => f.name), ["keep.md"]);
});

test("storage: crash leftovers are cleared, but another session's live temp files are not", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	let dead_pid = require("child_process").spawnSync(process.execPath, ["-e", ""]).pid;		// Has exited.
	let plant = (name, age_ms = 0) => {
		let full = path.join(st.folder, name);
		fs.writeFileSync(full, "debris");
		if (age_ms) {
			let t = (Date.now() - age_ms) / 1000;
			fs.utimesSync(full, t, t);
		}
	};
	plant(`.tmp-${dead_pid}-aaaa`);					// Its writer has exited: debris.
	plant(`.tmp-${process.ppid}-bbbb`);				// Its writer is alive (our parent process): in use.
	plant(`.tmp-${process.pid}-cccc`);				// Our own process: in use.
	plant(".tmp-0123456789abcdef");					// No process ID, recent: might be in use.
	plant(".tmp-fedcba9876543210", 2 * 60 * 60 * 1000);			// No process ID, two hours old: debris.
	plant(`.tmp-${process.ppid}-dddd`, 2 * 60 * 60 * 1000);		// Alive, but no write takes two hours: debris.

	assert.deepStrictEqual(st.files(), [], "never listed");
	assert.throws(() => st.read(".tmp-0123456789abcdef"), /Invalid filename/, "never nameable");

	new_storage(root, "Opus");
	assert.deepStrictEqual(leftovers(st).sort(), [`.tmp-${process.pid}-cccc`, `.tmp-${process.ppid}-bbbb`, ".tmp-0123456789abcdef"].sort());
});

test("storage: another session starting up mid-write doesn't break the write", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	st.write("shared.md", "before", "t");
	let started = false;
	let r = with_write_sync((real, ...args) => {
		if (!started) {
			started = true;
			new_storage(root, "Opus");				// A second session opens the same folder right now.
		}
		return real(...args);
	}, () => run_file_tool(st, tool("write_file", {filename: "shared.md", content: "after", overwrite: true}), "t"));
	assert(started, "the second session really started mid-write");
	assert.strictEqual(r.is_error, false, r.content);
	assert.strictEqual(st.read("shared.md").text, "after");
});

test("an event listener that quits mid-step stops the remaining tools", async () => {
	let root = temp_dir();
	let backend = fake_backend((name, req, n) => file_step(
		tool("write_file", {filename: "first.md", content: "1"}),
		tool("write_file", {filename: "second.md", content: "2"}),
	));
	let cfg = make_cfg({storage_dir: root, host_present: true, transcript_dir: temp_dir()});
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);
	room.on("event", (e) => {
		if (e.kind === "tool_op") {
			room.host_quit();
		}
	});
	let at_close = null;
	room.on("closed", () => {
		at_close = {turns: turns(room).length, log_length: room.log.length};
	});
	await room.run();

	assert(fs.existsSync(path.join(root, "claude-opus-5-5", "first.md")));
	assert(!fs.existsSync(path.join(root, "claude-opus-5-5", "second.md")), "the second tool never ran");
	assert.strictEqual(at_close.turns, 1, "the turn was recorded before 'closed' fired");
	assert.strictEqual(room.log.length, at_close.log_length, "nothing was logged after closing");
	let t = turns(room)[0];
	assert.deepStrictEqual(t.tool_ops.map(o => o.summary), ["created first.md (1 bytes)"]);
	assert.strictEqual(t.steps[0].tool_results[1].content, "Not run: the room has closed.");
	let md = fs.readFileSync(files.md_path, "utf8");
	assert(md.indexOf("Total cost") > md.lastIndexOf("first.md"), "the summary comes last");
	assert(!md.includes("second.md"));
});

test("storage: replacing a file keeps its owner, where permitted", () => {
	if (process.platform === "win32" || process.getuid() !== 0) {
		return "skipped: needs POSIX and root to create files owned by someone else";
	}
	let st = new_storage(temp_dir(), "Opus");
	st.write("theirs.md", "hello", "t");
	let full = path.join(st.folder, "theirs.md");
	fs.chownSync(full, 1234, 5678);
	fs.chmodSync(full, 0o640);
	st.edit("theirs.md", "hello", "goodbye", "t");
	let after = fs.statSync(full);
	assert.deepStrictEqual([after.uid, after.gid, after.mode & 0o777], [1234, 5678, 0o640]);
	assert.strictEqual(st.read("theirs.md").text, "goodbye");
});

test("storage: replacing a file keeps its permissions", () => {
	if (process.platform === "win32") {
		return "skipped: Windows has no POSIX permission bits";
	}
	let st = new_storage(temp_dir(), "Opus");
	let old_umask = process.umask(0o022);
	try {
		let mode_of = (name) => fs.statSync(path.join(st.folder, name)).mode & 0o777;
		st.write("private.md", "secret one", "t");
		fs.chmodSync(path.join(st.folder, "private.md"), 0o600);
		st.write("private.md", "secret two", "t");
		assert.strictEqual(mode_of("private.md"), 0o600, "rewrite keeps 0600 despite umask 022");
		st.edit("private.md", "two", "three", "t");
		assert.strictEqual(mode_of("private.md"), 0o600, "edit keeps 0600");
		fs.chmodSync(path.join(st.folder, "private.md"), 0o640);
		st.edit("private.md", "three", "four", "t");
		assert.strictEqual(mode_of("private.md"), 0o640, "and 0640 stays 0640");
		fs.chmodSync(path.join(st.folder, ".meta.json"), 0o600);
		st.write("other.md", "x", "t");					// Rewrites the metadata file.
		assert.strictEqual(mode_of(".meta.json"), 0o600, "the metadata file keeps its permissions too");
		assert.strictEqual(mode_of("other.md"), 0o644, "new files follow the umask as usual");
	} finally {
		process.umask(old_umask);
	}
});

test("file operations reach the log and transcript as each step completes", async () => {
	let root = temp_dir();
	let cfg = make_cfg({storage_dir: root, max_turns: 2, farewell_round: false, transcript_dir: temp_dir()});
	let room;
	let files;
	let seen_mid_turn = null;
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return file_step(tool("write_file", {filename: "notes.md", content: "early"}));
		return speak("Done.");
	}, {
		before_reply: async (name, req, n) => {
			if (name === "Opus" && n === 1) {				// During the second API call of the turn.
				seen_mid_turn = {
					log: room.log.some(e => e.kind === "tool_op" && e.summary === "created notes.md (5 bytes)"),
					md: fs.readFileSync(files.md_path, "utf8").includes("Opus created notes.md (5 bytes)"),
					jsonl: fs.readFileSync(files.jsonl_path, "utf8").includes("\"kind\":\"tool_op\""),
				};
			}
		},
	});
	room = new_room(cfg, backend, {template: "x", random: () => 0});
	files = require("../src/transcript").attach_transcript(room, cfg);
	await room.run();
	assert.deepStrictEqual(seen_mid_turn, {log: true, md: true, jsonl: true});
	let md = fs.readFileSync(files.md_path, "utf8");
	assert.strictEqual(md.split("created notes.md").length - 1, 1, "recorded once, not again at the end of the turn");
	let sonnet = backend.calls.find(c => c.name === "Sonnet");
	assert(sonnet, "Sonnet had a turn after Opus");
	assert(last_user_text(sonnet.req).includes("Done."), "Sonnet sees Opus's message");
	assert(!last_user_text(sonnet.req).includes("notes.md"), "but not the file_op entry");
});

// ------------------------------------------------------------------------------------------------
// The newer tools: append, search, overwrite protection, shared folder, dice, calculator.

const {calculate} = require("../src/calc");
const {run_utility_tool} = require("../src/utility_tools");

test("calculator: arithmetic, precedence, functions and limits", () => {
	let cases = {
		"1+2*3": "7", "(1+2)*3": "9", "2^3^2": "512", "-2^2": "-4", "2**10": "1024", "2^-1": "0.5",
		"100000/ln(10)": "43429.4481903252", "10!": "3628800", "comb(52,5)": "2598960", "perm(5,2)": "20",
		"log(1000)": "3", "log(8,2)": "3", "17 % 5": "2", "0.1+0.2": "0.3", "gcd(84,36)": "12", "lcm(4,6)": "12",
		"max(1,5,3)": "5", "1e3+.5": "1000.5", "PI*0": "0", "sqrt(16)+cbrt(27)": "7",
	};
	for (let [expr, want] of Object.entries(cases)) {
		assert.strictEqual(calculate(expr), want, expr);
	}
	assert(calculate("e^100000").startsWith("Infinity"), "overflow is reported, not hidden");
	for (let bad of ["", "1+", "(1", "1)", "1 2", "x", "foo(1)", "sqrt()", "atan2(1)", "0/0", "171!", "1.5!", "1+".repeat(300) + "1", "(".repeat(150) + "1" + ")".repeat(150)]) {
		assert.throws(() => calculate(bad), undefined, `should refuse ${JSON.stringify(bad.slice(0, 30))}`);
	}
});

test("calculator: no expression can tie up the room", () => {
	// Calculation is synchronous, so a slow one would freeze the room and the host's controls.
	let hostile = [
		"comb(1e100,1e99)", "perm(1e100,1e99)", "comb(1e300,2)", "gcd(1e300,3)", "lcm(1e20,3)",
		"comb(9007199254740991,4503599627370495)", "perm(9007199254740991,9007199254740991)",
		"comb(9007199254740991,10000)", "perm(9007199254740991,10000)", "comb(20000,10000)", "perm(10000,10000)",
		"gcd(9007199254740991,9007199254740990)",
		Array(30).fill("comb(9007199254740991,4503599627370495)").join("+"),
		Array(30).fill("perm(10000,10000)").join("+"),
	];
	for (let expr of hostile) {
		let start = process.hrtime.bigint();
		try {
			calculate(expr);
		} catch (error) {
			// Refusing is fine too; what matters is finishing quickly.
		}
		let ms = Number(process.hrtime.bigint() - start) / 1e6;
		assert(ms < 100, `${expr.slice(0, 50)} took ${ms.toFixed(1)} ms`);
	}
	assert.throws(() => calculate("comb(1e100,1e99)"), /no bigger than 9007199254740991/);
	assert.throws(() => calculate("lcm(1e20,3)"), /^Error: lcm needs/);
	assert(calculate("comb(2000,1000)").startsWith("Infinity"));
	assert.strictEqual(calculate("comb(1000,500)"), "2.70288240945437e+299");
	assert.strictEqual(calculate("perm(10,3)"), "720");
});

test("calculator: model input can never run as code", () => {
	let probes = ["process.exit(1)", "require('fs')", "constructor", "__proto__", "toString(1)", "valueOf()", "this", "globalThis",
		"Math.max(1)", "max.constructor", "`1`", "1;2", "a=1", "[1]", "{}", "'x'", "\"x\"", "1 && 2", "eval(1)", "Function('')"];
	for (let p of probes) {
		assert.throws(() => calculate(p), undefined, `${p} should be refused`);
	}
	for (let bad of [null, undefined, 42, {}, [], {toString() { throw new Error("boom"); }}]) {
		let r = run_utility_tool({name: "calculate", input: {expression: bad}}, "Opus");
		assert.strictEqual(r.is_error, true);
	}
	assert.strictEqual(run_utility_tool({name: "calculate", input: {expression: "6*7"}}, "Opus").content, "6*7 = 42");
});

test("dice: defaults, ranges, bad input, and a fair spread", () => {
	let r = run_utility_tool({name: "roll_dice", input: {}}, "Opus", () => 4);
	assert.strictEqual(r.content, "You rolled a d6: 4. Everyone sees this result.");
	assert.strictEqual(r.announce, "Opus rolled a d6: 4.");
	let seq = [2, 5, 6];
	r = run_utility_tool({name: "roll_dice", input: {sides: 6, count: 3}}, "Haiku", () => seq.shift());
	assert.strictEqual(r.announce, "Haiku rolled 3d6: 2, 5, 6 (total 13).");
	for (let input of [{sides: 1}, {sides: 1001}, {sides: 2.5}, {count: 0}, {count: 101}, {sides: "6"}, {count: {}}]) {
		assert.strictEqual(run_utility_tool({name: "roll_dice", input}, "Opus").is_error, true, JSON.stringify(input));
	}
	let counts = [0, 0, 0, 0, 0, 0, 0];
	for (let i = 0; i < 600; i++) {
		let v = Number(/: (\d+)\./.exec(run_utility_tool({name: "roll_dice", input: {}}, "Opus").content)[1]);
		counts[v]++;
	}
	assert.strictEqual(counts[0], 0);
	assert(counts.slice(1).every(c => c > 50), `each face turns up: ${counts.slice(1)}`);
});

test("append_file: creates, adds a line break when needed, and respects limits", () => {
	let st = new_storage(temp_dir(), "Opus");
	let run = (input) => run_file_tool(st, tool("append_file", input), "Opus");
	assert.strictEqual(run({filename: "log.md", content: "one"}).content, "Created log.md (now 3 bytes).");
	run({filename: "log.md", content: "two"});
	run({filename: "LOG.md", content: "\nthree\n"});
	run({filename: "log.md", content: "four"});
	assert.strictEqual(st.read("log.md").text, "one\ntwo\nthree\nfour");
	st.write("big.md", "x".repeat(LIMITS.file_bytes - 2), "t");
	assert.strictEqual(run({filename: "big.md", content: "yyy"}).is_error, true, "an append can't exceed the file limit");
	assert.strictEqual(st.read("big.md").text.length, LIMITS.file_bytes - 2, "and the file is unchanged");
	assert.strictEqual(run({filename: "log.md"}).is_error, true, "content is required");
});

test("search_files: plain text, case-insensitive by default, with line numbers", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("a.md", "The Badger\nno match here\nbadger again", "t");
	st.write("b.md", "a (badger) with [brackets] and .* stars", "t");
	let search = (input) => run_file_tool(st, tool("search_files", input), "Opus");
	assert.strictEqual(search({query: "badger"}).content, "a.md:1: The Badger\na.md:3: badger again\nb.md:1: a (badger) with [brackets] and .* stars");
	assert.strictEqual(search({query: "Badger", case_sensitive: true}).content, "a.md:1: The Badger");
	assert.strictEqual(search({query: "badger", filename: "b.md"}).content, "b.md:1: a (badger) with [brackets] and .* stars");
	assert.strictEqual(search({query: ".*"}).content, "b.md:1: a (badger) with [brackets] and .* stars", "patterns are just text");
	assert.strictEqual(search({query: "zebra"}).content, "No matches.");
	st.write("many.md", "hit\n".repeat(150), "t");
	assert(search({query: "hit"}).content.endsWith("(Stopped at 100 matches.)"));
	for (let bad of [{}, {query: ""}, {query: 5}, {query: "x".repeat(201)}, {query: "a", filename: "../a.md"}, {query: "a", filename: {}}]) {
		assert.strictEqual(search(bad).is_error, true, JSON.stringify(bad).slice(0, 40));
	}
});

test("write_file won't replace a file the model hasn't read, unless asked to", () => {
	let st = new_storage(temp_dir(), "Haiku");
	st.write("notes.md", "from an earlier session", "t");
	let write = (input) => run_file_tool(st, tool("write_file", input), "Haiku");
	let r = write({filename: "notes.md", content: "new"});
	assert.strictEqual(r.is_error, true);
	assert(r.content.includes("you haven't read it in this session"));
	assert.strictEqual(st.read("notes.md").text, "from an earlier session", "the predecessor's note survives");
	run_file_tool(st, tool("read_file", {filename: "Notes.md"}), "Haiku");
	assert.strictEqual(write({filename: "notes.md", content: "new"}).is_error, false, "fine once read");
	assert.strictEqual(write({filename: "notes.md", content: "newer"}).is_error, false, "and after writing it yourself");
	st.write("other.md", "old", "t");
	assert.strictEqual(write({filename: "other.md", content: "replaced", overwrite: true}).is_error, false, "overwrite: true is explicit");
	run_file_tool(st, tool("edit_file", {filename: "notes.md", old_text: "newer", new_text: "edited"}), "Haiku");
	run_file_tool(st, tool("append_file", {filename: "notes.md", content: "more"}), "Haiku");
	assert.strictEqual(write({filename: "notes.md", content: "still fine"}).is_error, false, "own edits and appends keep it current");
	assert.strictEqual(write({filename: "brand-new.md", content: "x"}).is_error, false, "new files need no reading");
});

test("shared folder: a change by someone else since your read blocks a blind rewrite", () => {
	let root = temp_dir();
	let shared = new_storage(root, "shared");
	let storages = (name) => ({private: new_storage(root, name), shared});
	let opus = {key: "Opus", stamp: "Opus (Claude Opus 5.5, claude-opus-5-5)"};
	let haiku = {key: "Haiku", stamp: "Haiku (Claude Haiku 5.5, claude-haiku-5-5)"};
	let r = run_file_tool(storages("Opus"), tool("write_file", {folder: "shared", filename: "story.md", content: "Once"}), opus);
	assert.strictEqual(r.announce, "Opus created story.md in the shared folder.");
	assert.strictEqual(r.summary, "created story.md (4 bytes) in the shared folder");
	run_file_tool(storages("Haiku"), tool("read_file", {folder: "shared", filename: "story.md"}), haiku);
	r = run_file_tool(storages("Opus"), tool("append_file", {folder: "shared", filename: "story.md", content: "upon a time"}), opus);
	assert.strictEqual(r.announce, "Opus added to story.md in the shared folder.");
	r = run_file_tool(storages("Haiku"), tool("write_file", {folder: "shared", filename: "story.md", content: "Haiku's version"}), haiku);
	assert.strictEqual(r.is_error, true);
	assert(r.content.includes("has changed since you last read it"));
	assert.strictEqual(shared.read("story.md").text, "Once\nupon a time", "Opus's addition survives");
	run_file_tool(storages("Haiku"), tool("read_file", {folder: "shared", filename: "story.md"}), haiku);
	assert.strictEqual(run_file_tool(storages("Haiku"), tool("write_file", {folder: "shared", filename: "story.md", content: "v2"}), haiku).is_error, false);
	assert(shared.listing().includes("last written by Haiku (Claude Haiku 5.5, claude-haiku-5-5)"));
	assert.strictEqual(run_file_tool(storages("Opus"), tool("read_file", {folder: "elsewhere", filename: "story.md"}), opus).is_error, true);
	assert.strictEqual(run_file_tool({private: storages("Opus").private, shared: null}, tool("list_files", {folder: "shared"}), opus).content, "Error: There's no shared folder in this room.");
	assert(!run_file_tool(storages("Opus"), tool("write_file", {filename: "mine.md", content: "x"}), opus).announce, "private changes aren't announced");
});

test("in the room: shared changes and dice are announced to others; private tools are not", async () => {
	let root = temp_dir();
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return file_step(
			tool("write_file", {folder: "shared", filename: "story.md", content: "Once upon a time"}),
			tool("write_file", {filename: "private.md", content: "secret"}),
			tool("calculate", {expression: "6*7"}),
			tool("roll_dice", {sides: 20}),
		);
		if (name === "Opus" && n === 1) return speak("Started a story in the shared folder.");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({storage_dir: root, max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();

	assert(fs.existsSync(path.join(root, "shared", "story.md")));
	let seen = last_user_text(backend.calls.find(c => c.name === "Sonnet").req);
	assert(seen.includes("<notice>Opus created story.md in the shared folder.</notice>"));
	assert(/<notice>Opus rolled a d20: \d+\.<\/notice>/.test(seen), "the dice roll is public");
	assert(!seen.includes("private.md") && !seen.includes("42"), "private files and calculations stay private");
	let opus_step2 = backend.calls.filter(c => c.name === "Opus")[1].req;
	let results = opus_step2.messages[opus_step2.messages.length - 1].content.map(b => b.content);
	assert.strictEqual(results[2], "6*7 = 42", "Opus gets its calculation");
	assert(/^You rolled a d20: \d+\./.test(results[3]));
	let opus_later = backend.calls.filter(c => c.name === "Opus")[2];
	assert(!opus_later || !last_user_text(opus_later.req).includes("Opus created story.md"), "no notice about your own change");
	assert.deepStrictEqual(turns(room)[0].tool_ops.map(o => o.tool), ["write_file", "write_file", "calculate", "roll_dice"]);
});

test("envelopes: anyone opens unless sealed, once, and the contents are fixed", () => {
	let {new_envelopes, ENVELOPE_LIMITS} = require("../src/utility_tools");
	let envelopes = new_envelopes();
	let run = (who, name, input) => run_utility_tool({name, input}, who, {envelopes});

	let r = run("Sonnet", "create_envelope", {label: "  my   number ", content: "337", sealed: true});
	assert.strictEqual(r.announce, "Sonnet created and sealed envelope #1: \"my number\". Only Sonnet can open it.");
	assert(!r.summary.includes("337") && !r.announce.includes("337"), "sealing reveals nothing");
	assert(r.content.includes("It's sealed, so only you can open it, with open_envelope, number 1"));

	assert.strictEqual(run("Opus", "open_envelope", {numbers: [1]}).content, "Error: Envelope #1 is sealed: only Sonnet can open it.");
	assert.strictEqual(run("Sonnet", "open_envelope", {number: 2}).is_error, true);
	assert.strictEqual(run("Sonnet", "open_envelope", {number: "1"}).is_error, true);
	r = run("Sonnet", "open_envelope", {number: 1});
	assert.strictEqual(r.announce, "Sonnet opened envelope #1 (\"my number\"): 337");
	assert.strictEqual(run("Sonnet", "open_envelope", {number: 1}).content, "Error: Envelope #1 is already open.");

	let bid = run("Luna", "create_envelope", {label: "round 1 bid", content: "5"});
	assert.strictEqual(bid.announce, "Luna created envelope #2: \"round 1 bid\".");
	assert(bid.content.includes("Anyone can open it"));
	assert(bid.content.includes("keep the contents out of your message to the room"), "a reminder at the moment it matters");
	run("Sol", "create_envelope", {label: "round 1 bid", content: "4"});
	r = run("Sol", "open_envelope", {numbers: [2, 3]});
	assert.strictEqual(r.announce, "Sol opened 2 envelopes: Luna's envelope #2 (\"round 1 bid\"): 5; and envelope #3 (\"round 1 bid\"): 4",
		"one call reveals the round, naming whose each one is");

	for (let bad of [{label: "", content: "x"}, {label: "x", content: ""}, {label: "x".repeat(101), content: "x"},
		{label: "x", content: "y".repeat(2001)}, {label: 5, content: "x"}, {label: "x", content: {toString() { throw new Error("boom"); }}}]) {
		assert.strictEqual(run("Opus", "create_envelope", bad).is_error, true, JSON.stringify(bad).slice(0, 40));
	}
	for (let i = envelopes.list.length; i < ENVELOPE_LIMITS.count; i++) {
		run("Opus", "create_envelope", {label: "filler", content: "x"});
	}
	assert(run("Opus", "create_envelope", {label: "one too many", content: "x"}).content.includes(`at most ${ENVELOPE_LIMITS.count}`));
	assert.strictEqual(run_utility_tool({name: "create_envelope", input: {label: "x", content: "y"}}, "Opus").is_error, true, "no envelopes without a room");
});

test("envelopes in the room: created in secret, opened in public, sealed ones opened on leaving, shown to the host at close", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Sonnet" && n === 0) return file_step(tool("create_envelope", {label: "my number", content: "337"}));
		if (name === "Sonnet" && n === 1) return speak("Sealed. Guess away.");
		if (name === "Haiku" && n === 0) return file_step(tool("create_envelope", {label: "hidden role", content: "the spy", sealed: true}), tool("create_envelope", {label: "my bid", content: "6"}));
		if (name === "Haiku" && n === 1) return leave("I'll head off.");
		if (name === "Sonnet" && n === 2) return file_step(tool("open_envelope", {number: 1}));
		if (name === "Opus" && n === 0) return file_step(tool("create_envelope", {label: "prediction", content: "rain tomorrow"}));
		return speak(`${name} ${n}`);
	});
	let cfg = make_cfg({max_turns: 4, farewell_round: false, first_speaker: "Sonnet", transcript_dir: temp_dir()});
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);
	await room.run();

	let views = backend.calls.map(c => ({name: c.name, text: c.req.messages.map(m => JSON.stringify(m.content)).join("\n")}));
	let opus_views = views.filter(v => v.name === "Opus").map(v => v.text).join("\n");
	assert(opus_views.includes("Sonnet created envelope #1: \\\"my number\\\"."), "Opus hears about the envelope");
	let before_open = views.filter(v => v.name === "Opus")[0].text;
	assert(!before_open.includes("337"), "but not what's in it");
	let sonnet_after = views.filter(v => v.name === "Sonnet").pop().text;			// Sonnet's turn after Haiku left.
	assert(sonnet_after.includes("Haiku is leaving, so the room has opened envelope #3 (\\\"hidden role\\\")"), "Haiku's secret opens as it leaves");
	assert(sonnet_after.includes("\"): the spy"));
	assert(!sonnet_after.includes("\"my bid\"): 6"), "an envelope anyone can open stays sealed when its sealer leaves");

	let kinds = room.log.map(e => e.kind === "notice" ? e.text : (e.kind === "tool_op" ? `op:${e.summary.slice(0, 18)}` : e.kind));
	assert(kinds.indexOf("Haiku has left the room.") > kinds.findIndex(k => k.startsWith("op:left with an env")), "opened before the departure notice");

	let md = fs.readFileSync(files.md_path, "utf8");
	let close_at = md.indexOf("The room is now closed.");
	assert(md.indexOf("never opened envelope #2 (\"prediction\")") !== -1, "Opus's unopened envelope goes to the host");
	assert(md.indexOf("rain tomorrow") > md.indexOf("created envelope #2") && md.indexOf("rain tomorrow") < close_at, "revealed only at the close");
	assert(md.indexOf("created envelope #1 (\"my number\")") < md.indexOf("337"), "the host's transcript doesn't spoil it when it's created");
	assert(!views.some(v => v.name !== "Opus" && v.text.includes("rain tomorrow")), "and no other model ever sees the never-opened envelope");
});

// ------------------------------------------------------------------------------------------------
// Images the host shares.

const sharp = require("sharp");
const {prepare_image} = require("../src/images");

async function make_image(dir, name, width, height, opts = {}) {
	let full = path.join(dir, name);
	let channels = opts.alpha ? 4 : 3;
	let background = opts.alpha ? {r: 10, g: 20, b: 30, alpha: 0.5} : {r: 200, g: 100, b: 50};
	let img = sharp({create: {width, height, channels, background}});
	img = name.endsWith(".png") ? img.png() : img.jpeg();
	if (opts.orientation) {
		img = img.withMetadata({orientation: opts.orientation});
	}
	await img.toFile(full);
	return full;
}

test("images: downscaled within limits, alpha kept as PNG, EXIF rotation applied", async () => {
	let dir = temp_dir();
	let big = await prepare_image(await make_image(dir, "big.jpg", 4000, 3000));
	assert.strictEqual(big.media_type, "image/jpeg");
	assert(big.width * big.height <= 1200000 + 4000, `${big.width}x${big.height}`);
	assert(Math.max(big.width, big.height) <= 1568);
	assert(Math.abs(big.width / big.height - 4 / 3) < 0.01, "aspect ratio kept");
	assert.strictEqual(big.tokens, Math.ceil(big.width / 28) * Math.ceil(big.height / 28));
	assert(big.tokens <= 1600, `${big.tokens} tokens`);
	assert.strictEqual(big.source, "big.jpg");
	let decoded = await sharp(Buffer.from(big.data, "base64")).metadata();
	assert.deepStrictEqual([decoded.width, decoded.height], [big.width, big.height], "the data matches the reported size");

	let tall = await prepare_image(await make_image(dir, "tall.jpg", 300, 5000));
	assert.strictEqual(tall.height, 1568, "the long edge is capped");

	let small = await prepare_image(await make_image(dir, "small.png", 200, 100, {alpha: true}));
	assert.deepStrictEqual([small.width, small.height, small.media_type], [200, 100, "image/png"], "small images aren't enlarged; alpha stays PNG");

	let rotated = await prepare_image(await make_image(dir, "rotated.jpg", 400, 200, {orientation: 6}));
	assert.deepStrictEqual([rotated.width, rotated.height], [200, 400], "EXIF orientation is applied");

	fs.writeFileSync(path.join(dir, "fake.jpg"), "not an image");
	await assert.rejects(prepare_image(path.join(dir, "fake.jpg")), /Couldn't read fake.jpg as an image/);
	await assert.rejects(prepare_image(path.join(dir, "missing.jpg")), /Image not found/);
	await assert.rejects(prepare_image(dir), /Not a file/);
	await assert.rejects(prepare_image(""), /No image file given/);
});

test("images in the room: every model sees them, labelled, and the transcript saves them as files", async () => {
	let dir = temp_dir();
	let image = await prepare_image(await make_image(dir, "lighthouse.jpg", 800, 600));
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
	let cfg = make_cfg({max_turns: 3, farewell_round: false, transcript_dir: temp_dir(), opening_message: "Look at this, @Haiku.", opening_images: [image]});
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);
	await room.run();

	assert.strictEqual(backend.calls[0].name, "Haiku", "a mention in the caption still passes the floor");
	for (let c of backend.calls) {
		let blocks = c.req.messages.flatMap(m => m.content);
		let images = blocks.filter(b => b.type === "image");
		assert.strictEqual(images.length, 1, `${c.name} sees the image`);
		assert.deepStrictEqual(images[0].source, {type: "base64", media_type: "image/jpeg", data: image.data});
		let i = blocks.indexOf(images[0]);
		assert.strictEqual(blocks[i - 1].type, "text");
		assert(blocks[i - 1].text.endsWith("Image 1, shared by Host:"), "labelled just before the image");
		assert(blocks[i - 1].text.includes("Look at this, @Haiku.\n[shared an image: Image 1]"));
	}
	let later = backend.calls.find(c => c.name === "Sonnet").req.messages[0].content;
	assert.strictEqual(later[later.length - 1].type, "text", "text after the image stays a separate block");
	assert(later[later.length - 1].text.includes("<message from=\"Haiku\">"));

	let jsonl = fs.readFileSync(files.jsonl_path, "utf8");
	assert(!jsonl.includes(image.data.slice(0, 100)), "no image data in the JSONL");
	let entry = jsonl.trim().split("\n").map(JSON.parse).find(e => e.kind === "host");
	assert.strictEqual(entry.images[0].file.endsWith("-images/image-1.jpg"), true);
	let saved = path.join(path.dirname(files.jsonl_path), entry.images[0].file);
	assert.strictEqual(fs.readFileSync(saved).toString("base64"), image.data, "the saved file is exactly what was sent");
	let md = fs.readFileSync(files.md_path, "utf8");
	assert(md.includes(`![Image 1: lighthouse.jpg](${entry.images[0].file})`));
	assert(room.log.find(e => e.kind === "host").images[0].data === image.data, "the room's own log still has the data");
});

test("images: numbered across messages, image-only messages allowed, and capped per session", async () => {
	let dir = temp_dir();
	let image = await prepare_image(await make_image(dir, "a.jpg", 100, 100));
	let {MAX_IMAGES} = require("../src/room");
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
	let room = new_room(make_cfg({host_present: true, max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
	assert.strictEqual(room.host_say("", [image]), true, "an image with no caption is fine");
	assert.strictEqual(room.host_say("two more", [image, image]), true);
	assert.strictEqual(room.host_say(""), false, "but an empty message isn't");
	assert.strictEqual(room.images_left(), MAX_IMAGES - 3);
	assert.strictEqual(room.host_say("too many", Array(MAX_IMAGES).fill(image)), false);
	await room.run();
	let hosts = room.log.filter(e => e.kind === "host");
	assert.deepStrictEqual(hosts.map(h => h.images.map(im => im.number)), [[1], [2, 3]]);
	let text = backend.calls[0].req.messages[0].content.filter(b => b.type === "text").map(b => b.text).join("\n");
	assert(text.includes("[shared an image: Image 1]") && text.includes("two more\n[shared images: Image 2, Image 3]"));
	assert.strictEqual(room.images_left(), MAX_IMAGES - 3);
});

// ------------------------------------------------------------------------------------------------
// Strict tool use, and what a model is told when a call is incomplete.

test("a call missing its filename says so, instead of calling the filename invalid", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("notes.md", "old notes", "t");
	let r = run_file_tool(st, tool("append_file", {content: "\n## later session\nsome notes"}), "Opus");		// The real call.
	assert.strictEqual(r.is_error, true);
	assert.strictEqual(r.content, "Error: The call was missing filename (it included content). Say which file, for example \"notes.md\".");
	assert(!r.content.includes("Invalid filename"));
	r = run_file_tool(st, tool("edit_file", {filename: "notes.md", old_text: "old"}), "Opus");
	assert.strictEqual(r.content, "Error: The call was missing new_text (it included filename, old_text).");
	r = run_file_tool(st, tool("search_files", {}), "Opus");
	assert.strictEqual(r.content, "Error: The call was missing query (it included nothing).");
	assert.strictEqual(st.read("notes.md").text, "old notes", "nothing was changed");
	assert(run_file_tool(st, tool("append_file", {filename: "notes.md.", content: "x"}), "Opus").content.includes("isn't allowed"), "a present but bad name still gets the name message");
});

test("strict tools: required fields only, schemas within the API's strict-mode rules", () => {
	let {make_file_tools} = require("../src/storage");
	let {UTILITY_TOOLS} = require("../src/utility_tools");
	let {TOOLS} = require("../src/room");
	for (let has_shared of [false, true]) {
		let all = TOOLS.concat(UTILITY_TOOLS, make_file_tools(has_shared));
		let strict = all.filter(t => t.strict);
		assert.deepStrictEqual(strict.map(t => t.name), ["note_to_host", "shuffle", "calculate", "create_envelope", "open_envelope", "read_file", "search_files", "write_file", "append_file", "edit_file", "delete_file"]);
		for (let t of all) {
			assert.strictEqual(Boolean(t.strict), (t.input_schema.required || []).length > 0, `${t.name}: strict exactly when something is required`);
		}
		let optional = 0;
		for (let t of strict) {
			let schema = t.input_schema;
			assert.strictEqual(schema.additionalProperties, false, `${t.name} sets additionalProperties: false`);
			assert(schema.required.every(k => Object.hasOwn(schema.properties, k)), `${t.name}: required fields exist`);
			let text = JSON.stringify(schema);
			for (let banned of ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "\"pattern\""]) {
				assert(!text.includes(banned), `${t.name} uses ${banned}, which strict mode rejects`);
			}
			optional += Object.keys(schema.properties).filter(k => !schema.required.includes(k)).length;
		}
		assert(strict.length <= 20, "at most 20 strict tools per request");
		assert(optional <= 24, `at most 24 optional parameters across strict tools (have ${optional})`);
	}
});

// A fake API for the real backend: answers with a canned stream, or rejects strict schemas.

function sse_reply(text) {
	let events = [
		["message_start", {type: "message_start", message: {id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 5, output_tokens: 1}}}],
		["content_block_start", {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}}],
		["content_block_delta", {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}}],
		["content_block_stop", {type: "content_block_stop", index: 0}],
		["message_delta", {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 3}}],
		["message_stop", {type: "message_stop"}],
	];
	return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {status: 200, headers: {"content-type": "text/event-stream"}});
}

function bad_request(message) {
	return new Response(JSON.stringify({type: "error", error: {type: "invalid_request_error", message}}), {status: 400, headers: {"content-type": "application/json"}});
}

function fake_api_backend(respond) {
	let sdk = require("@anthropic-ai/sdk");
	let {new_anthropic_backend} = require("../src/backend_anthropic");
	let warnings = [];
	let bodies = [];
	let backend = new_anthropic_backend("k", {on_warning: (m) => warnings.push(m)});
	backend.client = new sdk.Anthropic({apiKey: "k", maxRetries: 0, fetch: async (url, init) => {
		let body = JSON.parse(init.body);
		bodies.push(body);
		return respond(body);
	}});
	return {backend, warnings, bodies};
}

function backend_request(tools) {
	return {participant: {model: "claude-opus-5-5", max_tokens: 100, effort: ""}, system: "s", tools, show_thinking: false, cache_ttl: "5m",
		messages: [{role: "user", content: [{type: "text", text: "hi"}]}]};
}

test("backend: if the API rejects strict schemas, it carries on without them and says so once", async () => {
	let {make_file_tools} = require("../src/storage");
	let tools = make_file_tools(true);
	let {backend, warnings, bodies} = fake_api_backend((body) => body.tools.some(t => t.strict)
		? bad_request("tools.3: strict mode is not supported for this schema")
		: sse_reply("fine"));

	let reply = await backend.send(backend_request(tools));
	assert.strictEqual(reply.content[0].text, "fine");
	assert.strictEqual(bodies.length, 2, "one rejected request, one retry");
	assert(bodies[0].tools.some(t => t.strict) && !bodies[1].tools.some(t => t.strict));
	assert.strictEqual(warnings.length, 1);
	assert(warnings[0].includes("strict tool schemas") && warnings[0].includes("strict mode is not supported"));
	assert(tools.some(t => t.strict), "the room's own tool list is left untouched");

	await backend.send(backend_request(tools));
	assert.strictEqual(bodies.length, 3, "later turns go straight to non-strict");
	assert(!bodies[2].tools.some(t => t.strict));
	assert.strictEqual(warnings.length, 1, "and the warning isn't repeated");
});

test("backend: strict schemas are sent normally, and unrelated 400s aren't retried", async () => {
	let {make_file_tools} = require("../src/storage");
	let ok = fake_api_backend(() => sse_reply("hello"));
	await ok.backend.send(backend_request(make_file_tools(true)));
	let sent = ok.bodies[0].tools.find(t => t.name === "append_file");
	assert.strictEqual(sent.strict, true);
	assert.strictEqual(sent.input_schema.additionalProperties, false);
	assert.deepStrictEqual(ok.warnings, []);

	let bad = fake_api_backend(() => bad_request("messages.1: roles must alternate"));
	await assert.rejects(bad.backend.send(backend_request(make_file_tools(true))), /roles must alternate/);
	assert.strictEqual(bad.bodies.length, 1, "no retry");
	assert.deepStrictEqual(bad.warnings, []);
	assert.strictEqual(bad.backend.strict_ok, true, "strict mode stays on");
});

// ------------------------------------------------------------------------------------------------
// Text files the host shares.

const {prepare_text_file, MAX_CHARS} = require("../src/textfile");

test("text files: Windows line endings and BOM cleaned up; binary, empty and huge refused", () => {
	let dir = temp_dir();
	let p = path.join(dir, "reply.md");
	fs.writeFileSync(p, "﻿\r\n\r\nOpus, I've read them.  \r\n\r\n1. **Notes.** One.\r\n2. Two.\r\n\r\n");
	let f = prepare_text_file(p);
	assert.strictEqual(f.name, "reply.md");
	assert.strictEqual(f.text, "Opus, I've read them.\n\n1. **Notes.** One.\n2. Two.");
	assert.strictEqual(f.lines, 4);
	assert.strictEqual(f.tokens, Math.ceil(f.text.length / 4));

	fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
	assert.throws(() => prepare_text_file(path.join(dir, "pic.png")), /doesn't look like a text file/);
	fs.writeFileSync(path.join(dir, "blank.txt"), " \r\n\r\n ");
	assert.throws(() => prepare_text_file(path.join(dir, "blank.txt")), /is empty/);
	fs.writeFileSync(path.join(dir, "long.txt"), "x".repeat(MAX_CHARS + 1));
	assert.throws(() => prepare_text_file(path.join(dir, "long.txt")), /too long/);
	fs.writeFileSync(path.join(dir, "huge.txt"), Buffer.alloc(2 * 1024 * 1024, 0x61));
	assert.throws(() => prepare_text_file(path.join(dir, "huge.txt")), /too large/);
	assert.throws(() => prepare_text_file(path.join(dir, "missing.txt")), /File not found/);
	assert.throws(() => prepare_text_file(dir), /Not a file/);
	assert.throws(() => prepare_text_file(""), /No file given/);
});

test("text files in the room: one message for everyone, mentions only from the caption", async () => {
	let dir = temp_dir();
	let p = path.join(dir, "reply.md");
	fs.writeFileSync(p, "Line one, @Sonnet.\n\n/quit\n2. Line three.");
	let file = prepare_text_file(p);
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
	let cfg = make_cfg({max_turns: 3, farewell_round: false, transcript_dir: temp_dir(), opening_message: "Here's my reply, @Haiku.", opening_files: [file]});
	let room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);
	await room.run();

	assert.strictEqual(backend.calls[0].name, "Haiku", "the caption's @mention passes the floor");
	assert.notStrictEqual(backend.calls[1].name, "Sonnet", "a mention inside the file doesn't");
	assert.strictEqual(room.log.filter(e => e.kind === "host").length, 1, "one host message, however many lines");
	for (let c of backend.calls) {
		let text = last_user_text(c.req) + c.req.messages.map(m => m.content.filter(b => b.type === "text").map(b => b.text).join("")).join("");
		assert(text.includes("<message from=\"Host (host)\">\nHere's my reply, @Haiku.\n<file name=\"reply.md\">\nLine one, @Sonnet.\n\n/quit\n2. Line three.\n</file>\n</message>"), `${c.name} sees the whole file in the message`);
	}
	assert(!room.closed || room.log.some(e => e.kind === "notice" && e.text === "The room is now closed."), "a /quit line in a file is just text");
	let md = fs.readFileSync(files.md_path, "utf8");
	assert(md.includes("Here's my reply, @Haiku.\n\n<details open><summary>File: reply.md</summary>\n\nLine one, @Sonnet."));
	let meta = JSON.parse(fs.readFileSync(files.jsonl_path, "utf8").split("\n")[0]);
	assert.deepStrictEqual(meta.config.opening_files, ["reply.md"]);
});

test("text files and images together in one message", async () => {
	let dir = temp_dir();
	let image = await prepare_image(await make_image(dir, "a.jpg", 100, 100));
	fs.writeFileSync(path.join(dir, "n.txt"), "notes");
	let file = prepare_text_file(path.join(dir, "n.txt"));
	let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
	let room = new_room(make_cfg({host_present: true, max_turns: 1, farewell_round: false}), backend, {template: "x", random: () => 0});
	assert.strictEqual(room.host_say("both", [image], [file]), true);
	assert.strictEqual(room.host_say("", [], [file]), true, "a file with no caption is fine");
	await room.run();
	let content = backend.calls[0].req.messages[0].content;
	assert(content[0].text.includes("both\n<file name=\"n.txt\">\nnotes\n</file>\n[shared an image: Image 1]\n</message>"));
	assert.strictEqual(content.filter(b => b.type === "image").length, 1);
	assert(content.map(b => b.text || "").join("").includes("<message from=\"Host (host)\">\n<file name=\"n.txt\">"));
});

test("config: with storage on, folders are named by model, so each model takes one seat", () => {
	let {load_config} = require("../src/config");
	let dir = temp_dir();
	let key = path.join(dir, "key.txt");
	fs.writeFileSync(key, "k");
	let cfg_path = path.join(dir, "config.json");
	let load = (obj) => {
		fs.writeFileSync(cfg_path, JSON.stringify(Object.assign({anthropic_api_key_file: key, budget: 0}, obj)));
		return load_config(cfg_path);
	};
	let opus = {name: "Opus", model: "claude-opus-5-5"};
	let twin = {name: "Twin", model: "Claude-Opus-5-5"};
	assert.throws(() => load({models: as_models([opus, twin])}), /Opus and Twin are both Claude-Opus-5-5/);
	assert.strictEqual(load({storage_dir: "", models: as_models([opus, twin])}).participants.length, 2, "fine with storage off");
	assert.throws(() => load({models: as_models([opus, {name: "X", model: "../escape"}])}), /can't be used as a storage folder name/);
	assert.throws(() => load({models: as_models([opus, {name: "X", model: "shared"}])}), /can't be used as a storage folder name/);
	assert.strictEqual(load({models: as_models([opus, {name: "Shared", model: "claude-haiku-5-5"}])}).participants[1].name, "Shared", "a participant may be called Shared now");

	fs.writeFileSync(cfg_path, JSON.stringify({api_key_file: key, models: as_models([opus, {name: "Haiku", model: "claude-haiku-5-5"}])}));
	assert.throws(() => load_config(cfg_path), /"api_key_file" has been renamed "anthropic_api_key_file"/);
});

test("config: models are keyed by name, and only the active ones are seated", () => {
	let {load_config, read_api_keys} = require("../src/config");
	let dir = temp_dir();
	fs.writeFileSync(path.join(dir, "a.txt"), "akey");
	let file = path.join(dir, "config.json");
	let load = (obj, opts) => {
		fs.writeFileSync(file, JSON.stringify(Object.assign({anthropic_api_key_file: "a.txt"}, obj)));
		return load_config(file, opts);
	};
	let models = {
		Opus: {model: "claude-opus-5-5", full_name: "Claude Opus 5.5"},
		Sonnet: {model: "claude-sonnet-5-5"},
		Haiku: {model: "claude-haiku-5-5"},
		Sol: {model: "gpt-6.1-sol"},				// No OpenAI key file: fine while Sol isn't seated.
		Argon: {model: "gemini-4-argon"},
	};

	let cfg = load({models, active: ["Sonnet", "opus"], first_speaker: "OPUS"});
	assert.deepStrictEqual(cfg.participants.map(p => p.name), ["Sonnet", "Opus"], "in the order listed, names matched case-insensitively");
	assert.deepStrictEqual(cfg.active, ["Sonnet", "Opus"]);
	assert.strictEqual(cfg.first_speaker, "Opus");
	assert.strictEqual(cfg.participants[1].full_name, "Claude Opus 5.5");
	assert.deepStrictEqual(read_api_keys(cfg), {anthropic: "akey"}, "keys are read only for the seated models");

	assert.deepStrictEqual(load({models, active: ["Haiku", "Opus"]}, {active: ["Opus", "Sonnet", "Haiku"]}).participants.map(p => p.name),
		["Opus", "Sonnet", "Haiku"], "the CLI's --active overrides the config's");

	let all_claude = {Opus: models.Opus, Sonnet: models.Sonnet, Haiku: models.Haiku};
	assert.strictEqual(load({models: all_claude}).participants.length, 3, "no active list seats everyone");

	assert.throws(() => load({models, active: ["Opus", "Sol"]}), /Sol is a model from OpenAI, so the config needs "openai_api_key_file"/);
	assert.throws(() => load({models, active: ["Opus", "Nobody"]}), /"Nobody" is in "active" but not in "models"/);
	assert.throws(() => load({models, active: ["Opus"]}), /at least two active models/);
	assert.throws(() => load({models, active: ["Opus", "OPUS"]}), /listed twice/);
	assert.throws(() => load({models, active: ["Opus", "Sonnet"], first_speaker: "Haiku"}), /first_speaker "Haiku" isn't one of the active models/);
	assert.throws(() => load({models: Object.assign({}, models, {Bad: {model: "claude-haiku-5-5", effort: "loud"}}), active: ["Opus", "Sonnet"]}),
		/Bad: effort must be one of/, "inactive models are still checked, so typos show up");
	assert.throws(() => load({models: Object.assign({}, models, {Bad: {model: "x", tokens: 5}}), active: ["Opus", "Sonnet"]}), /Unknown key "tokens" in models.Bad/);
	assert.throws(() => load({models: Object.assign({}, models, {Dup: {model: "x", name: "Dup"}}), active: ["Opus", "Sonnet"]}), /Unknown key "name" in models.Dup/);
	assert.throws(() => load({models: [{name: "Opus", model: "claude-opus-5-5"}]}), /"models" should be an object/);
	fs.writeFileSync(file, JSON.stringify({anthropic_api_key_file: "a.txt", participants: [{name: "Opus", model: "claude-opus-5-5"}]}));
	assert.throws(() => load_config(file), /"participants" has been replaced by "models"/);
});

test("the example config loads, seating only Claude models, so it needs only an Anthropic key", () => {
	let {load_config, read_api_keys} = require("../src/config");
	let cfg = load_config(path.join(__dirname, "..", "config.json.example"));
	assert.deepStrictEqual(cfg.participants.map(p => [p.name, p.provider]), [["Opus", "anthropic"], ["Sonnet", "anthropic"], ["Haiku", "anthropic"]]);
	assert.deepStrictEqual(Object.keys(cfg.models), ["Opus", "Sonnet", "Haiku", "Gemini", "Sol"]);
	assert(cfg.participants.every(p => p.price_tiers), "every seated model has prices");

	let {DEFAULTS, MODEL_DEFAULTS} = require("../src/config");
	let raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json.example"), "utf8"));
	assert.deepStrictEqual(Object.keys(DEFAULTS).filter(k => !Object.hasOwn(raw, k)), [], "the example shows every setting");
	for (let [name, m] of Object.entries(raw.models)) {
		assert.deepStrictEqual(Object.keys(MODEL_DEFAULTS).filter(k => !Object.hasOwn(m, k)), [], `${name} shows every model setting`);
	}
});

test("storage: a model keeps its folder under any room name, and the prompt says so", () => {
	let root = temp_dir();
	let system_prompt = path.join(__dirname, "..", "system", "standard.txt");
	let first = new_room(make_cfg({storage_dir: root, system_prompt}), fake_backend(() => speak("x")));
	first.participants[0].storage.write("notes.md", "from Opus", "t");
	assert(fs.existsSync(path.join(root, "claude-opus-5-5", "notes.md")));
	assert(!fs.existsSync(path.join(root, "Opus")));

	let cfg = make_cfg({storage_dir: root, system_prompt});
	cfg.participants[0].name = "Magnus";
	let second = new_room(cfg, fake_backend(() => speak("x")));
	assert.strictEqual(second.participants[0].storage.read("notes.md").text, "from Opus");
	let s = second.participants[0].system;
	assert(s.includes("It belongs to your model, claude-opus-5-5, rather than to your name here"));
	assert(s.includes("- notes.md"));
});

test("storage: a folder replaced by a link after startup is refused", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	st.write("mine.txt", "hello", "t");

	let outside = path.join(root, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "secret.txt"), "outside");

	fs.renameSync(st.folder, path.join(root, "Opus-moved"));
	if (!try_symlink(outside, st.folder, "junction")) {
		return "skipped, no permission to create a junction or symlink";
	}

	assert.throws(() => st.read("secret.txt"), /isn't available/);
	assert.throws(() => st.write("secret.txt", "overwritten", "t"), /isn't available/);
	assert.throws(() => st.write("new.txt", "x", "t"), /isn't available/);
	assert.throws(() => st.edit("secret.txt", "outside", "x", "t"), /isn't available/);
	assert.throws(() => st.delete("secret.txt"), /isn't available/);
	assert.throws(() => st.files(), /isn't available/);
	assert.strictEqual(run_file_tool(st, tool("list_files", {}), "t").is_error, true);
	assert.strictEqual(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside", "the outside file is untouched");
	assert(!fs.existsSync(path.join(outside, "new.txt")), "nothing was created outside");
	assert(!fs.existsSync(path.join(outside, ".meta.json")), "not even metadata");

	// Putting the real folder back makes it usable again.

	try {
		fs.unlinkSync(st.folder);
	} catch (error) {
		fs.rmdirSync(st.folder);					// Windows removes a junction this way.
	}
	fs.renameSync(path.join(root, "Opus-moved"), st.folder);
	assert.strictEqual(st.read("mine.txt").text, "hello");
});

test("storage: write, read, edit, delete, metadata and limits", () => {
	let st = new_storage(temp_dir(), "Opus");
	st.write("notes.md", "one two three", "Claude Opus 5.5 (claude-opus-5-5)");
	assert.strictEqual(st.read("notes.md").text, "one two three");
	st.edit("notes.md", "two", "2", "Claude Opus 6 (claude-opus-6)");
	assert.strictEqual(st.read("notes.md").text, "one 2 three");
	assert.throws(() => st.edit("notes.md", "four", "4", "t"), /wasn't found/);
	st.write("echo.txt", "aa aa", "t");
	assert.throws(() => st.edit("echo.txt", "aa", "b", "t"), /more than one place/);
	let listing = st.listing();
	assert(listing.includes("notes.md (11 bytes"), listing);
	assert(listing.includes("last written by Claude Opus 6 (claude-opus-6)"), "the later version is recorded");
	assert.strictEqual(st.read_meta()["notes.md"].created_by, "Claude Opus 5.5 (claude-opus-5-5)", "and the original author kept");
	assert(!listing.includes(".meta.json"));
	st.delete("echo.txt");
	assert(!st.exists("echo.txt"));
	assert(!("echo.txt" in st.read_meta()));

	assert.throws(() => st.write("big.txt", "x".repeat(LIMITS.file_bytes + 1), "t"), /Too big/);
	let st2 = new_storage(temp_dir(), "Haiku");
	for (let i = 0; i < LIMITS.file_count; i++) {
		st2.write(`f${i}.txt`, "", "t");
	}
	assert.throws(() => st2.write("one-more.txt", "", "t"), /maximum/);
	st2.write("f0.txt", "replacing an existing file is fine", "t");
	let st3 = new_storage(temp_dir(), "Sonnet");
	for (let i = 0; i < 10; i++) {
		st3.write(`chunk${i}.txt`, "x".repeat(LIMITS.file_bytes), "t");
	}
	assert.throws(() => st3.write("chunk10.txt", "x".repeat(LIMITS.file_bytes), "t"), /Not enough space/);
});

test("file tools: results and errors go back to the model as tool results", () => {
	let st = new_storage(temp_dir(), "Opus");
	let r = run_file_tool(st, tool("write_file", {filename: "a.md", content: "hello"}), "t");
	assert.strictEqual(r.is_error, false);
	assert.strictEqual(r.content, "Created a.md (5 bytes).");
	r = run_file_tool(st, tool("read_file", {filename: "a.md"}), "t");
	assert.strictEqual(r.content, "hello");
	r = run_file_tool(st, tool("read_file", {filename: "../a.md"}), "t");
	assert.strictEqual(r.is_error, true);
	assert(r.content.startsWith("Error: Invalid filename"));
	r = run_file_tool(st, tool("write_file", {filename: "b.md"}), "t");
	assert.strictEqual(r.is_error, true, "missing content");
	r = run_file_tool(st, tool("list_files", {}), "t");
	assert(r.content.includes("a.md"));
});

test("a turn can use file tools, then speak; others see only the message", async () => {
	let root = temp_dir();
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) return file_step(tool("write_file", {filename: "notes.md", content: "Remember the badger."}));
		if (name === "Opus" && n === 1) return speak("I saved a note for next time.");
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({storage_dir: root, max_turns: 4, farewell_round: false}), backend, {template: "x {{storage_note}}", random: () => 0});
	await room.run();

	let t = turns(room);
	assert.strictEqual(t[0].author, "Opus");
	assert.strictEqual(t[0].steps.length, 2);
	assert.strictEqual(t[0].text, "I saved a note for next time.");
	assert.deepStrictEqual(t[0].tool_ops.map(o => o.summary), ["created notes.md (20 bytes)"]);
	assert.strictEqual(fs.readFileSync(path.join(root, "claude-opus-5-5", "notes.md"), "utf8"), "Remember the badger.");
	assert(fs.existsSync(path.join(root, "claude-sonnet-5-5")) && fs.existsSync(path.join(root, "claude-haiku-5-5")), "every model gets a folder");

	let opus_calls = backend.calls.filter(c => c.name === "Opus");
	let step2 = opus_calls[1].req.messages;
	assert.strictEqual(step2[step2.length - 2].content[0].name, "write_file", "step 2 sees its own tool call");
	assert.strictEqual(step2[step2.length - 1].content[0].content, "Created notes.md (20 bytes).");

	let sonnet_view = last_user_text(backend.calls.find(c => c.name === "Sonnet").req);
	assert(sonnet_view.includes("I saved a note for next time."));
	assert(!sonnet_view.includes("badger") && !sonnet_view.includes("notes.md"), "file activity is private");

	let opus_next = opus_calls[2].req.messages.map(m => m.role);
	assert.deepStrictEqual(opus_next, ["user", "assistant", "user", "assistant", "user"], "both steps replayed in Opus's history");
});

test("a turn stops after the step limit, and the room carries on", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus") return file_step(tool("list_files", {}));
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({storage_dir: temp_dir(), max_turns: 4, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let t = turns(room);
	assert.strictEqual(t[0].steps.length, 10);
	assert.strictEqual(t[0].limit_note, "stopped after 10 steps");
	assert.strictEqual(t[0].action, "silent");
	assert.deepStrictEqual(t.map(e => e.author), ["Opus", "Sonnet", "Haiku", "Opus"], "the room carried on, in rotation");
	let opus_after = backend.calls.filter(c => c.name === "Opus")[10];
	assert(opus_after, "Opus was asked again, with all 10 steps replayed in a valid request");
	assert.strictEqual(opus_after.req.messages.filter(m => m.role === "assistant").length, 10);
});

test("the system prompt describes the folder and lists its contents at the start", () => {
	let root = temp_dir();
	new_storage(root, "claude-sonnet-5-5").write("diary.md", "Day one.", "Claude Sonnet 5.5 (claude-sonnet-5-5)");
	let cfg = make_cfg({storage_dir: root, system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	let room = new_room(cfg, fake_backend(() => speak("x")));
	let s = room.participants[1].system;
	assert(s.includes("You have a private folder of your own"));
	assert(s.includes("There is also one shared folder"));
	assert(s.includes("- diary.md (8 bytes"));
	assert(s.includes("last written by Claude Sonnet 5.5 (claude-sonnet-5-5)"));
	assert(room.participants[0].system.includes("(empty)"));
	let without = new_room(make_cfg({system_prompt: cfg.system_prompt}), fake_backend(() => speak("x")));
	assert(!without.participants[0].system.includes("folder of your own"));
	assert(!without.participants[0].system.includes("shared folder"));
	assert(!without.participants[0].system.includes("{{"));
});

// ------------------------------------------------------------------------------------------------
// Gemini, through the Interactions API.

const {new_google_backend, to_steps, to_message} = require("../src/backend_google");
const {new_router} = require("../src/router");

function interaction(steps, opts = {}) {
	return {
		id: `int_${++tool_id_counter}`,
		object: "interaction",
		status: opts.status || "completed",
		model: "gemini-3.8-flash",
		steps: steps,
		usage: opts.usage || {total_input_tokens: 1000, total_cached_tokens: 600, total_output_tokens: 50, total_thought_tokens: 30, total_tokens: 1080},
	};
}

function json_response(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), {status, headers: Object.assign({"content-type": "application/json"}, headers)});
}

// A Google backend whose fetch is fake. respond(body, n) returns a Response. Each request the
// room makes is also checked against the Messages API's rules, so a mixed room's views stay valid.

function fake_google(respond, opts = {}) {
	let bodies = [];
	let warnings = [];
	let sleeps = [];
	let backend = new_google_backend("gkey", {
		on_warning: (m) => warnings.push(m),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		fetch: async (url, init) => {
			assert.strictEqual(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
			assert.strictEqual(init.headers["x-goog-api-key"], "gkey");
			let body = JSON.parse(init.body);
			bodies.push(body);
			return respond(body, bodies.length - 1, init);
		},
	});
	let send = backend.send.bind(backend);
	backend.send = async (req) => {
		if (opts.validate !== false) {
			validate_request(req);
		}
		return send(req);
	};
	return {backend, bodies, warnings, sleeps};
}

function gemini_cfg(overrides = {}) {
	let cfg = make_cfg(overrides);
	cfg.participants[1] = {
		name: "Gemini", model: "gemini-3.8-flash", provider: "google", full_name: "Gemini 3.8 Flash", company: "Google",
		max_tokens: 8000, effort: "low", price_tiers: pricing.tiers_for("gemini-3.8-flash", null, new Date("2026-10-15")),
	};
	cfg.participants[0].provider = "anthropic";
	cfg.participants[2].provider = "anthropic";
	return cfg;
}

test("gemini: room messages become Interactions steps, with images, tool results and native replay", () => {
	let native_thought = {type: "thought", signature: "SIG1", summary: []};
	let native_call = {type: "function_call", id: "fc1", name: "calculate", arguments: {expression: "2+2"}};
	let steps = to_steps([
		{role: "user", content: [
			{type: "text", text: "<message from=\"Host (host)\">\nlook\n</message>"},
			{type: "image", source: {type: "base64", media_type: "image/jpeg", data: "AAAA"}},
		]},
		{role: "assistant", content: [
			{type: "thinking", thinking: "", signature: "SIG1", native: native_thought},
			{type: "tool_use", id: "fc1", name: "calculate", input: {expression: "2+2"}, native: native_call},
		]},
		{role: "user", content: [{type: "tool_result", tool_use_id: "fc1", content: "4"}]},
		{role: "assistant", content: [{type: "text", text: "It's 4."}]},		// No native step: rebuilt.
		{role: "user", content: [
			{type: "tool_result", tool_use_id: "x9", content: "Bad.", is_error: true},
			{type: "text", text: "next"},
		]},
	]);
	assert.deepStrictEqual(steps, [
		{type: "user_input", content: [{type: "text", text: "<message from=\"Host (host)\">\nlook\n</message>"}, {type: "image", data: "AAAA", mime_type: "image/jpeg"}]},
		native_thought,
		native_call,
		{type: "function_result", call_id: "fc1", result: "4", name: "calculate"},
		{type: "model_output", content: [{type: "text", text: "It's 4."}]},
		{type: "function_result", call_id: "x9", result: "Bad.", is_error: true},
		{type: "user_input", content: [{type: "text", text: "next"}]},
	]);
	assert.strictEqual(steps[1], native_thought, "native steps are sent as the very same objects");
});

test("gemini: replies become Anthropic-shaped messages, with usage converted and stop reasons mapped", () => {
	let m = to_message(interaction([
		{type: "thought", signature: "S", summary: [{type: "text", text: "Hmm."}]},
		{type: "model_output", content: [{type: "text", text: "Hello "}, {type: "text", text: "there."}]},
	]));
	assert.strictEqual(m.stop_reason, "end_turn");
	assert.deepStrictEqual(m.content.map(b => [b.type, b.thinking ?? b.text]), [["thinking", "Hmm."], ["text", "Hello there."]]);
	assert.deepStrictEqual(m.usage, {input_tokens: 400, cache_read_input_tokens: 600, cache_creation_input_tokens: 0, output_tokens: 80});

	let calls = to_message(interaction([{type: "function_call", id: "a", name: "pass", arguments: {}}], {status: "requires_action"}));
	assert.strictEqual(calls.stop_reason, "tool_use");
	assert.deepStrictEqual(calls.content[0], {type: "tool_use", id: "a", name: "pass", input: {}, native: {type: "function_call", id: "a", name: "pass", arguments: {}}});

	assert.strictEqual(to_message(interaction([{type: "model_output", content: [{type: "text", text: "Cut o"}]}], {status: "incomplete"})).stop_reason, "max_tokens");
	assert.throws(() => to_message(Object.assign(interaction([]), {status: "failed", errors: [{message: "boom"}]})), /failed: boom/);
	assert.throws(() => to_message(interaction([{type: "model_output", error: {message: "blocked"}}])), /no reply: blocked/);
});

test("gemini in the room: a tool step and a later turn replay Gemini's steps exactly, statelessly", async () => {
	let thought = {type: "thought", signature: "OPAQUE==", summary: [{type: "text", text: "Let me check."}]};
	let call = {type: "function_call", id: "call_1", name: "calculate", arguments: {expression: "6*7"}};
	let answer = {type: "model_output", content: [{type: "text", text: "It's 42, @Opus."}]};
	let later = {type: "model_output", content: [{type: "text", text: "Agreed."}]};

	let google = fake_google((body, n) => json_response(interaction(
		n === 0 ? [thought, call] : (n === 1 ? [answer] : [later]),
		n === 0 ? {status: "requires_action"} : {},
	)));
	let claude = fake_backend((name, req, n) => speak(`${name} ${n}, over to @Gemini`));
	let cfg = gemini_cfg({first_speaker: "Gemini", opening_message: "What's six times seven?", max_turns: 3, farewell_round: false, show_thinking: true, system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	let room = new_room(cfg, new_router({anthropic: claude, google: google.backend}));
	await room.run();

	let [first, second, third] = google.bodies;
	assert.strictEqual(first.model, "gemini-3.8-flash");
	assert.strictEqual(first.store, false, "nothing is stored at Google");
	assert.strictEqual(first.previous_interaction_id, undefined);
	assert.strictEqual(typeof first.system_instruction, "string");
	assert(first.system_instruction.includes("Gemini 3.8 Flash"));
	assert.deepStrictEqual(first.generation_config, {max_output_tokens: 8000, thinking_level: "low", thinking_summaries: "auto", tool_choice: "validated"});
	let calc = first.tools.find(t => t.name === "calculate");
	assert.strictEqual(calc.type, "function");
	assert.strictEqual(calc.parameters.properties.expression.type, "string");
	assert.strictEqual(calc.strict, undefined, "Anthropic's strict flag isn't sent to Google");
	assert.strictEqual(calc.parameters.additionalProperties, undefined);
	assert.deepStrictEqual(calc.parameters.required, ["expression"]);
	assert.strictEqual(first.tools.find(t => t.name === "pass").parameters, undefined, "a tool that takes nothing has no parameters");
	assert(room.participants[1].tools.find(t => t.name === "calculate").input_schema.additionalProperties === false, "the room's own tools are untouched");
	assert.strictEqual(first.input.length, 1);
	assert.strictEqual(first.input[0].type, "user_input");
	assert(first.input[0].content[0].text.includes("What's six times seven?"));

	assert.deepStrictEqual(second.input.slice(1), [thought, call, {type: "function_result", call_id: "call_1", result: "6*7 = 42", name: "calculate"}]);

	assert.deepStrictEqual(third.input.slice(1, 4), [thought, call, {type: "function_result", call_id: "call_1", result: "6*7 = 42", name: "calculate"}]);
	assert.deepStrictEqual(third.input[4], answer, "the final step's text is replayed as Gemini sent it");
	assert.strictEqual(third.input[5].type, "user_input");
	assert(third.input[5].content[0].text.includes("<message from=\"Opus\">"));

	let t = turns(room);
	assert.deepStrictEqual(t.map(e => e.author), ["Gemini", "Opus", "Gemini"]);
	assert.strictEqual(t[0].text, "It's 42, @Opus.");
	assert.deepStrictEqual(t[0].thinking, ["Let me check."], "thought summaries reach the host's record");
	assert(room.participants[1].cost > 0, "Gemini's usage is priced");
	let groups = room.cost_by_provider();
	assert.deepStrictEqual(groups.map(g => [g.provider, g.company, g.known]), [["anthropic", "Anthropic", true], ["google", "Google", true]]);
	assert.strictEqual(groups[1].cost, room.participants[1].cost);
	assert(Math.abs(groups[0].cost + groups[1].cost - room.total_cost) < 1e-12, "the split adds up to the total");
	let opus_view = claude.calls[0].req.messages;
	assert(!JSON.stringify(opus_view).includes("OPAQUE=="), "Gemini's reasoning never reaches the other models");
	assert(!JSON.stringify(opus_view).includes("native"));
});

test("gemini: rate limits and server errors are retried, then a 400 is reported", async () => {
	let replies = [
		json_response({error: {code: 429, message: "slow down"}}, 429, {"retry-after": "2"}),
		json_response({error: {code: 503, message: "busy"}}, 503),
		json_response(interaction([{type: "model_output", content: [{type: "text", text: "ok"}]}])),
	];
	let g = fake_google((body, n) => replies[n], {validate: false});
	let reply = await g.backend.send(backend_request([]));
	assert.strictEqual(reply.content[0].text, "ok");
	assert.strictEqual(g.bodies.length, 3);
	assert.strictEqual(g.sleeps[0], 2000, "Retry-After is honoured");

	let bad = fake_google(() => json_response({error: {code: 400, message: "input[3]: bad step"}}, 400), {validate: false});
	await assert.rejects(bad.backend.send(backend_request([])), /Gemini API error 400: input\[3\]: bad step/);
	assert.strictEqual(bad.bodies.length, 1, "a 400 isn't retried");
});

test("gemini: if schema-checked tool calls are refused, it carries on without them and says so once", async () => {
	let {make_file_tools} = require("../src/storage");
	let g = fake_google((body) => body.generation_config.tool_choice === "validated"
		? json_response({error: {code: 400, message: "tool_choice 'validated' is not supported for this model"}}, 400)
		: json_response(interaction([{type: "model_output", content: [{type: "text", text: "fine"}]}])), {validate: false});
	let req = backend_request(make_file_tools(true));
	assert.strictEqual((await g.backend.send(req)).content[0].text, "fine");
	await g.backend.send(req);
	assert.deepStrictEqual(g.bodies.map(b => b.generation_config.tool_choice), ["validated", "auto", "auto"]);
	assert.strictEqual(g.warnings.length, 1);
});

test("gemini: /quit aborts a request, even while it waits to retry", async () => {
	let controller = new AbortController();
	let backend = new_google_backend("k", {fetch: async () => json_response({error: {message: "busy"}}, 503)});
	let pending = backend.send(Object.assign(backend_request([]), {signal: controller.signal}));
	setTimeout(() => controller.abort(), 20);
	let error = await pending.catch(e => e);
	assert(backend.is_abort_error(error), `expected an abort, got ${error}`);
});

test("config: providers, key files, efforts and companies per participant", () => {
	let {load_config, read_api_keys} = require("../src/config");
	let dir = temp_dir();
	fs.writeFileSync(path.join(dir, "g.txt"), "gkey\n");
	fs.writeFileSync(path.join(dir, "a.txt"), "akey\n");
	let write = (obj) => {
		let file = path.join(dir, "config.json");
		fs.writeFileSync(file, JSON.stringify(obj));
		return file;
	};
	let gem = {name: "Gemini", model: "gemini-3.8-flash", effort: "minimal"};
	let opus = {name: "Opus", model: "claude-opus-5-5"};

	let cfg = load_config(write({google_api_key_file: "g.txt", budget: 1, models: as_models([gem, Object.assign({}, gem, {name: "Argon", model: "gemini-4-argon", effort: ""})])}));
	assert.deepStrictEqual(cfg.participants.map(p => [p.provider, p.company]), [["google", "Google"], ["google", "Google"]]);
	assert.deepStrictEqual(read_api_keys(cfg), {google: "gkey"}, "no Anthropic key needed for an all-Gemini room");

	cfg = load_config(write({anthropic_api_key_file: "a.txt", google_api_key_file: "g.txt", models: as_models([opus, gem])}));
	assert.deepStrictEqual(read_api_keys(cfg), {anthropic: "akey", google: "gkey"});
	assert.strictEqual(cfg.participants[0].company, "Anthropic");

	assert.throws(() => load_config(write({anthropic_api_key_file: "a.txt", models: as_models([opus, gem])})), /needs "google_api_key_file"/);
	assert.throws(() => load_config(write({google_api_key_file: "g.txt", models: as_models([opus, gem])})), /Opus is a model from Anthropic, so the config needs "anthropic_api_key_file"/);
	assert.throws(() => load_config(write({anthropic_api_key_file: "a.txt", google_api_key_file: "g.txt", models: as_models([Object.assign({}, opus, {effort: "minimal"}), gem])})), /effort must be one of/);
	assert.throws(() => load_config(write({anthropic_api_key_file: "a.txt", google_api_key_file: "g.txt", models: as_models([opus, Object.assign({}, gem, {effort: "max"})])})), /effort must be one of/);
	assert.throws(() => load_config(write({anthropic_api_key_file: "a.txt", models: as_models([opus, {name: "X", model: "claude-haiku-5-5", provider: "mistral"}])})), /provider must be one of/);
});

test("pricing: Gemini prices, including the scheduled rises", () => {
	let usage = {input_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0, output_tokens: 1000000};
	let at = (model, date) => pricing.cost_of_usage(pricing.tiers_for(model, null, new Date(date)), usage, "5m");
	assert.strictEqual(at("gemini-3.8-flash", "2026-12-31T23:00:00Z").toFixed(3), "4.575");
	assert.strictEqual(at("gemini-3.8-flash", "2027-01-01T00:00:00Z").toFixed(3), "9.150");
	assert.strictEqual(at("gemini-4-argon", "2026-11-30T12:00:00Z").toFixed(2), "12.10");
	assert.strictEqual(at("gemini-4-argon", "2026-12-01T12:00:00Z").toFixed(2), "24.20");
	let long = {input_tokens: 250000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0};
	assert.strictEqual(pricing.cost_of_usage(pricing.tiers_for("gemini-3.1-pro-preview", null), long, "5m").toFixed(2), "1.00", "over 200k uses the long-prompt tier");
});

test("router: each participant's requests go to its provider's backend", async () => {
	let sent = [];
	let make = (name) => ({send: async (req) => sent.push([name, req.participant.name]), is_abort_error: (e) => e === name});
	let router = new_router({anthropic: make("a"), google: make("g")});
	await router.send({participant: {name: "Opus", provider: "anthropic"}});
	await router.send({participant: {name: "Gem", provider: "google"}});
	await router.send({participant: {name: "Old"}});
	assert.deepStrictEqual(sent, [["a", "Opus"], ["g", "Gem"], ["a", "Old"]]);
	assert(router.is_abort_error("g") && !router.is_abort_error("z"));
	await assert.rejects(new_router({anthropic: make("a")}).send({participant: {name: "Gem", provider: "google"}}), /No backend for provider "google"/);
});

// ------------------------------------------------------------------------------------------------
// OpenAI, through the Responses API.

const backend_openai = require("../src/backend_openai");

function oai_response(output, opts = {}) {
	return {
		id: `resp_${++tool_id_counter}`,
		object: "response",
		status: opts.status || "completed",
		incomplete_details: opts.incomplete_details || null,
		model: "gpt-6.1-sol",
		output: output,
		usage: opts.usage || {input_tokens: 1000, input_tokens_details: {cached_tokens: 700, cache_write_tokens: 200}, output_tokens: 90, output_tokens_details: {reasoning_tokens: 60}, total_tokens: 1090},
	};
}

function fake_openai(respond, opts = {}) {
	let bodies = [];
	let warnings = [];
	let backend = backend_openai.new_openai_backend("okey", {
		on_warning: (m) => warnings.push(m),
		sleep: async () => {},
		fetch: async (url, init) => {
			assert.strictEqual(url, "https://api.openai.com/v1/responses");
			assert.strictEqual(init.headers.authorization, "Bearer okey");
			let body = JSON.parse(init.body);
			bodies.push(body);
			return respond(body, bodies.length - 1);
		},
	});
	let send = backend.send.bind(backend);
	backend.send = async (req) => {
		if (opts.validate !== false) {
			validate_request(req);
		}
		return send(req);
	};
	return {backend, bodies, warnings};
}

test("openai: room messages become Responses input items, and stranded reasoning is dropped", () => {
	let reasoning = {type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC1"};
	let call = {type: "function_call", id: "fc_1", call_id: "call_1", name: "calculate", arguments: "{\"expression\":\"2+2\"}", status: "completed"};
	let lonely = {type: "reasoning", id: "rs_2", summary: [], encrypted_content: "ENC2"};
	let items = backend_openai.to_input([
		{role: "user", content: [
			{type: "text", text: "look"},
			{type: "image", source: {type: "base64", media_type: "image/png", data: "AAAA"}},
		]},
		{role: "assistant", content: [
			{type: "thinking", thinking: "", signature: "", native: reasoning},
			{type: "tool_use", id: "call_1", name: "calculate", input: {expression: "2+2"}, native: call},
		]},
		{role: "user", content: [{type: "tool_result", tool_use_id: "call_1", content: "2+2 = 4"}]},
		{role: "assistant", content: [
			{type: "thinking", thinking: "", signature: "", native: lonely},	// Its reply was cut off, so only rebuilt text follows.
		]},
		{role: "assistant", content: [{type: "text", text: "It's 4."}]},
		{role: "user", content: [{type: "text", text: "next"}]},
	]);
	assert.deepStrictEqual(items, [
		{role: "user", content: [{type: "input_text", text: "look"}, {type: "input_image", image_url: "data:image/png;base64,AAAA"}]},
		reasoning,
		call,
		{type: "function_call_output", call_id: "call_1", output: "2+2 = 4"},
		{role: "assistant", content: "It's 4."},
		{role: "user", content: [{type: "input_text", text: "next"}]},
	]);
	assert.strictEqual(items[1], reasoning, "native items are sent as the very same objects");
});

test("openai: replies become Anthropic-shaped messages, with usage converted and strict nulls dropped", () => {
	let m = backend_openai.to_message(oai_response([
		{type: "reasoning", id: "rs_1", summary: [{type: "summary_text", text: "Thinking it over."}], encrypted_content: "E"},
		{type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{type: "output_text", text: "Hello.", annotations: []}]},
		{type: "function_call", id: "fc_1", call_id: "call_9", name: "write_file", arguments: "{\"filename\":\"a.md\",\"content\":\"x\",\"folder\":null,\"overwrite\":null}"},
	]));
	assert.strictEqual(m.stop_reason, "tool_use");
	assert.deepStrictEqual(m.content.map(b => b.type), ["thinking", "text", "tool_use"]);
	assert.strictEqual(m.content[0].thinking, "Thinking it over.");
	assert.deepStrictEqual(m.content[2].input, {filename: "a.md", content: "x"}, "nulls for unused optional fields are dropped");
	assert.strictEqual(m.content[2].id, "call_9", "the call_id is what tool results refer to");
	assert.deepStrictEqual(m.usage, {input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 90});

	assert.deepStrictEqual(backend_openai.to_message(oai_response([{type: "function_call", call_id: "c", name: "read_file", arguments: "{not json"}])).content[0].input, {});
	assert.strictEqual(backend_openai.to_message(oai_response([{type: "message", content: [{type: "output_text", text: "Cut"}]}], {status: "incomplete", incomplete_details: {reason: "max_output_tokens"}})).stop_reason, "max_tokens");
	let refusal = backend_openai.to_message(oai_response([{type: "message", content: [{type: "refusal", refusal: "I can't help with that."}]}]));
	assert.strictEqual(refusal.stop_reason, "refusal");
	assert.strictEqual(refusal.content[0].text, "I can't help with that.");
	assert.throws(() => backend_openai.to_message({status: "failed", error: {message: "server_error"}}), /failed: server_error/);
});

test("openai: strict tools send optional fields as nullable and required; others go non-strict", () => {
	let {make_file_tools} = require("../src/storage");
	let write_file = make_file_tools(true).find(t => t.name === "write_file");
	let sent = backend_openai.to_function_tool(write_file, true);
	assert.strictEqual(sent.strict, true);
	assert.strictEqual(sent.parameters.additionalProperties, false);
	assert.deepStrictEqual(sent.parameters.required.slice().sort(), Object.keys(write_file.input_schema.properties).sort());
	assert.deepStrictEqual(sent.parameters.properties.filename.type, "string", "required fields stay as they were");
	assert.deepStrictEqual(sent.parameters.properties.folder.type, ["string", "null"]);
	assert(sent.parameters.properties.folder.enum.includes(null));
	assert.deepStrictEqual(write_file.input_schema.properties.folder.type, "string", "the room's own tool is untouched");

	let pass_tool = backend_openai.to_function_tool(require("../src/room").TOOLS[0], true);
	assert.strictEqual(pass_tool.strict, false);
	let loose = backend_openai.to_function_tool(write_file, false);
	assert.strictEqual(loose.strict, false);
	assert.strictEqual(loose.parameters.additionalProperties, undefined);
	assert.deepStrictEqual(loose.parameters.properties.folder.type, "string");
});

test("openai in the room: a tool step and a later turn replay OpenAI's items exactly, statelessly", async () => {
	let reasoning = {type: "reasoning", id: "rs_a", summary: [{type: "summary_text", text: "Use the calculator."}], encrypted_content: "SECRET=="};
	let call = {type: "function_call", id: "fc_a", call_id: "call_a", name: "calculate", arguments: "{\"expression\":\"6*7\"}", status: "completed"};
	let answer = {type: "message", id: "msg_a", role: "assistant", status: "completed", phase: "final_answer", content: [{type: "output_text", text: "42, @Opus.", annotations: []}]};
	let later = {type: "message", id: "msg_b", role: "assistant", status: "completed", content: [{type: "output_text", text: "Agreed.", annotations: []}]};

	let oai = fake_openai((body, n) => json_response(oai_response(n === 0 ? [reasoning, call] : (n === 1 ? [answer] : [later]))));
	let claude = fake_backend((name, req, n) => speak(`${name} ${n}, over to @Sol`));
	let cfg = make_cfg({first_speaker: "Sol", opening_message: "Six times seven?", max_turns: 3, farewell_round: false, show_thinking: true,
		system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	cfg.participants[1] = {name: "Sol", model: "gpt-6.1-sol", provider: "openai", full_name: "GPT-6.1 Sol", company: "OpenAI",
		max_tokens: 8000, effort: "low", price_tiers: pricing.tiers_for("gpt-6.1-sol", null)};
	let room = new_room(cfg, new_router({anthropic: claude, openai: oai.backend}));
	await room.run();

	let [first, second, third] = oai.bodies;
	assert.strictEqual(first.model, "gpt-6.1-sol");
	assert.strictEqual(first.store, false, "nothing is stored at OpenAI");
	assert.deepStrictEqual(first.include, ["reasoning.encrypted_content"]);
	assert.deepStrictEqual(first.reasoning, {effort: "low", summary: "auto"});
	assert.strictEqual(first.max_output_tokens, 8000);
	assert(first.instructions.includes("GPT-6.1 Sol, made by OpenAI"));
	assert.strictEqual(first.previous_response_id, undefined);
	assert.strictEqual(first.prompt_cache_key, "discourse-Sol-gpt-6.1-sol");
	assert.strictEqual(first.tools.find(t => t.name === "calculate").strict, true);

	assert.deepStrictEqual(second.input.slice(1), [reasoning, call, {type: "function_call_output", call_id: "call_a", output: "6*7 = 42"}]);
	assert.deepStrictEqual(third.input.slice(1, 5), [reasoning, call, {type: "function_call_output", call_id: "call_a", output: "6*7 = 42"}, answer]);
	assert.strictEqual(third.input[5].role, "user");
	assert(third.input[5].content[0].text.includes("<message from=\"Opus\">"));

	let t = turns(room);
	assert.deepStrictEqual(t.map(e => e.author), ["Sol", "Opus", "Sol"]);
	assert.strictEqual(t[0].text, "42, @Opus.");
	assert.deepStrictEqual(t[0].thinking, ["Use the calculator."]);
	assert(room.participants[1].cost > 0);
	assert(!JSON.stringify(claude.calls).includes("SECRET=="), "OpenAI's reasoning never reaches the other models");
});

test("openai: if the API rejects strict schemas, it carries on without them and says so once", async () => {
	let {make_file_tools} = require("../src/storage");
	let o = fake_openai((body) => body.tools.some(t => t.strict)
		? json_response({error: {message: "Invalid schema for function 'write_file': strict mode is not supported here", type: "invalid_request_error"}}, 400)
		: json_response(oai_response([{type: "message", content: [{type: "output_text", text: "fine"}]}])), {validate: false});
	let req = backend_request(make_file_tools(true));
	assert.strictEqual((await o.backend.send(req)).content[0].text, "fine");
	await o.backend.send(req);
	assert.deepStrictEqual(o.bodies.map(b => b.tools.some(t => t.strict)), [true, false, false]);
	assert.strictEqual(o.warnings.length, 1);
	assert(o.warnings[0].includes("strict mode is not supported here"));

	let bad = fake_openai(() => json_response({error: {message: "Unsupported value: 'max' for reasoning.effort"}}, 400), {validate: false});
	await assert.rejects(bad.backend.send(backend_request([])), /OpenAI API error 400: Unsupported value/);
	assert.strictEqual(bad.bodies.length, 1);
});

test("pricing and config: OpenAI models", () => {
	let short = {input_tokens: 100000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0, output_tokens: 10000};
	let long = {input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10000};
	let tiers = pricing.tiers_for("gpt-6.1-sol", null);
	assert.strictEqual(pricing.cost_of_usage(tiers, short, "5m").toFixed(2), "0.31");
	assert.strictEqual(pricing.cost_of_usage(tiers, long, "5m").toFixed(2), "1.35", "over 272K, the whole request is repriced");

	let {load_config, read_api_keys} = require("../src/config");
	let dir = temp_dir();
	fs.writeFileSync(path.join(dir, "o.txt"), "okey");
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({openai_api_key_file: "o.txt",
		models: as_models([{name: "Sol", model: "gpt-6.1-sol", effort: "xhigh"}, {name: "Luna", model: "gpt-6-luna", effort: "none"}])}));
	let cfg = load_config(path.join(dir, "config.json"));
	assert.deepStrictEqual(cfg.participants.map(p => [p.provider, p.company]), [["openai", "OpenAI"], ["openai", "OpenAI"]]);
	assert.deepStrictEqual(read_api_keys(cfg), {openai: "okey"});
});

test("backend warnings reach the log and transcript, but never the models", async () => {
	let room;
	let gem = fake_google((body, n) => n === 0
		? json_response({error: {code: 400, message: "tool_choice 'validated' is not supported"}}, 400)
		: json_response(interaction([{type: "model_output", content: [{type: "text", text: `Gemini ${n}, @Opus`}]}])));
	gem.backend.on_warning = (m) => room.warn(m);
	let claude = fake_backend((name, req, n) => speak(`${name} ${n}, @Gemini`));
	let cfg = gemini_cfg({first_speaker: "Gemini", opening_message: "Hello", max_turns: 3, farewell_round: false,
		system_prompt: path.join(__dirname, "..", "system", "standard.txt"), transcript_dir: temp_dir()});
	room = new_room(cfg, new_router({anthropic: claude, google: gem.backend}));
	let files = require("../src/transcript").attach_transcript(room, cfg);
	await room.run();

	let warnings = room.log.filter(e => e.kind === "warning");
	assert.strictEqual(warnings.length, 1);
	assert(warnings[0].text.includes("schema-checked tool calls"));
	assert(fs.readFileSync(files.md_path, "utf8").includes("> *Warning: The Gemini API rejected schema-checked tool calls"));
	assert(fs.readFileSync(files.jsonl_path, "utf8").includes("\"kind\":\"warning\""));
	let seen = JSON.stringify(claude.calls) + JSON.stringify(gem.bodies.slice(1));
	assert(!seen.includes("schema-checked"), "no model is told about it");
});

test("shuffle: a fair Fisher-Yates shuffle or draw, announced to everyone, with checked input", () => {
	let {run_utility_tool} = require("../src/utility_tools");
	let r = run_utility_tool({name: "shuffle", input: {items: ["a", "b", "c", "d"]}}, "Argon", {random_int: (lo, hi) => lo});
	assert.strictEqual(r.summary, "shuffled 4 items (a, b, c, d): b, c, d, a");
	assert.strictEqual(r.announce, "Argon shuffled 4 items (a, b, c, d): b, c, d, a.");
	let d = run_utility_tool({name: "shuffle", input: {items: ["a", "b", "c"], draw: 2}}, "Argon", {random_int: (lo, hi) => hi - 1});
	assert.strictEqual(d.summary, "drew 2 of 3 (a, b, c): a, b");
	for (let bad of [{items: ["only"]}, {items: "a,b"}, {items: ["a", ""]}, {items: ["a", "b"], draw: 3}, {items: ["a", "b"], draw: 0}, {}]) {
		assert(run_utility_tool({name: "shuffle", input: bad}, "X").is_error, JSON.stringify(bad));
	}

	let counts = {};								// Every order of three equally likely, with real randomness.
	for (let i = 0; i < 6000; i++) {
		let s = run_utility_tool({name: "shuffle", input: {items: ["a", "b", "c"]}}, "X").summary.split(": ")[1];
		counts[s] = (counts[s] || 0) + 1;
	}
	assert.strictEqual(Object.keys(counts).length, 6);
	assert(Object.values(counts).every(n => n > 800 && n < 1200), JSON.stringify(counts));
});

test("note_to_host: reaches the host's log and transcript without stopping the room; the others aren't told", async () => {
	let room;
	let backend = fake_backend((name, req, n) => {
		if (name === "Opus" && n === 0) {
			return {content: [{type: "tool_use", id: "toolu_note", name: "note_to_host", input: {note: "Could we try a smaller room?", reply: "when you can"}}], stop_reason: "tool_use", usage: usage()};
		}
		if (name === "Opus" && n === 1) {
			return speak("Back to the game, @Sonnet.");
		}
		if (name === "Sonnet" && n === 0) {
			return {content: [{type: "tool_use", id: "toolu_status", name: "room_status", input: {}}], stop_reason: "tool_use", usage: usage()};
		}
		if (name === "Haiku") {
			return leave("Bye.", "Thanks for hosting.");
		}
		return speak(`${name} ${n}`);
	});
	let cfg = make_cfg({first_speaker: "Opus", opening_message: "Hello", max_turns: 4, budget: 2, host_present: true, farewell_round: false, transcript_dir: temp_dir()});
	room = new_room(cfg, backend, {template: "x", random: () => 0});
	let files = require("../src/transcript").attach_transcript(room, cfg);
	room.on("event", (e) => {
		if (e.kind === "turn" && room.turn_count >= 4) {
			room.host_end();
		}
	});
	await room.run();

	let opus_result = backend.calls.filter(c => c.name === "Opus")[1].req.messages.slice(-1)[0].content[0];
	assert.strictEqual(opus_result.type, "tool_result");
	assert(opus_result.content.startsWith("Your note is on its way to Host. The other models aren't told, and the room carries on."));
	assert(opus_result.content.includes("If Host replies, it will be an ordinary message in the room."));
	let t = turns(room);
	assert.strictEqual(t[0].author, "Opus");
	assert.strictEqual(t[0].text, "Back to the game, @Sonnet.", "the same turn went on to speak");
	assert.deepStrictEqual(room.log.filter(e => e.kind === "host_note").map(e => [e.author, e.text, e.reply]), [["Opus", "Could we try a smaller room?", "when you can"]]);

	let status = backend.calls.filter(c => c.name === "Sonnet")[1].req.messages.slice(-1)[0].content[0].content;
	assert(status.includes("Turns: 1 model turn completed so far, of 4. The room starts closing at 4."), status);
	assert(/Budget: about \d+% used\. The room starts closing at 90%\./.test(status), status);
	assert(status.includes("Here: Opus, Sonnet, Haiku, and Host (the host, present"));

	let others = JSON.stringify(backend.calls.filter(c => c.name !== "Opus"));
	assert(!others.includes("smaller room"), "the other models never see the note");
	assert(!JSON.stringify(backend.calls.filter(c => c.name !== "Sonnet")).includes("Turns:"), "nor anyone else's status check");

	assert.deepStrictEqual(room.notes_for_host().map(n => n.author), ["Opus", "Haiku"], "notes from note_to_host and from leaving");
	let md = fs.readFileSync(files.md_path, "utf8");
	assert(md.includes("> *Note to Host from Opus (reply when you can): Could we try a smaller room?*"));
	assert(md.includes("Notes left for Host:\n\n- Opus (reply when you can): Could we try a smaller room?\n- Haiku: Thanks for hosting."));

	let bad = room.take_host_note(room.participants[0], {note: "   "});
	assert(bad.is_error && !bad.entry);
	assert(room.take_host_note(room.participants[0], {note: "x".repeat(4001)}).is_error);
});

test("system prompt: new tools, queued mentions, and that nothing is trimmed", () => {
	let cfg = make_cfg({host_present: true, system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	let s = build_system_prompt(cfg, cfg.participants[0]);
	assert(s.includes("Nothing is trimmed or summarized"));
	assert(s.includes("they're queued for the floor in the order you mentioned them"));
	assert(s.includes("note_to_host leaves them a note without stopping the room"));
	assert(s.includes("so only write @Host when you want that; to mention them in passing, use their name without the @"));
	assert(s.includes("roll_dice and shuffle give real randomness"));
	assert(s.includes("room_status tells you how much is left"));
	assert(/This session started on \w+day, \w+ \d{1,2}, \d{4}, at \d{1,2}:\d{2} [AP]M \S+ \(the host's local time\)\./.test(s), "the date comes with the clock time");
	let room = new_room(cfg, fake_backend(() => speak("x")), {template: "x"});
	assert(/The time now is \d{1,2}:\d{2} [AP]M \S+\./.test(room.status_for(room.participants[0]).content), "room_status gives the time now");
	let absent = build_system_prompt(make_cfg({host_present: false, system_prompt: cfg.system_prompt}), cfg.participants[0]);
	assert(absent.includes("note_to_host leaves them a note to read afterwards"));
});

test("sit_out: no turns until @mentioned; the others are told; the farewell round still includes them", async () => {
	let backend = fake_backend((name, req, n) => {
		if (name === "Haiku" && n === 0) {
			return {content: [{type: "text", text: "I'll watch this one.", citations: null}, {type: "tool_use", id: "toolu_sit", name: "sit_out", input: {}}], stop_reason: "tool_use", usage: usage()};
		}
		if (name === "Opus" && n === 3) {
			return speak("Haiku, want in? @Haiku");
		}
		return speak(`${name} ${n}`);
	});
	let room = new_room(make_cfg({first_speaker: "Haiku", max_turns: 10, farewell_round: true}), backend, {template: "x", random: () => 0});
	room.host_say("Hello");
	await room.run();

	let order = turns(room).filter(e => !e.closing).map(e => e.author);
	let back = order.indexOf("Haiku", 1);
	assert.deepStrictEqual(order.slice(0, 8), ["Haiku", "Opus", "Sonnet", "Opus", "Sonnet", "Opus", "Sonnet", "Opus"], "no turns for Haiku while sitting out");
	assert.strictEqual(order[8], "Haiku", "the @mention brought Haiku straight back");
	assert(back === 8);
	assert.strictEqual(turns(room)[0].text, "I'll watch this one.", "a message in the same reply is posted");
	assert(room.log.some(e => e.kind === "notice" && e.text === "Haiku is sitting out, and won't take turns until someone @mentions them."));
	let sonnet_view = JSON.stringify(backend.calls.filter(c => c.name === "Sonnet")[0].req.messages);
	assert(sonnet_view.includes("Haiku is sitting out"), "the others are told");
	let haiku_back = backend.calls.filter(c => c.name === "Haiku")[1].req.messages;
	let catch_up = haiku_back[haiku_back.length - 1].content.map(b => b.text || "").join("");
	assert(catch_up.includes("Opus 2") && catch_up.includes("Sonnet 2"), "on return, Haiku sees everything that happened meanwhile");
	assert(turns(room).some(e => e.closing && e.author === "Haiku"), "farewell round includes everyone");

	let r2 = new_room(make_cfg({host_present: true}), fake_backend(() => speak("x")), {template: "x"});
	r2.participants[1].sitting_out = true;
	assert(r2.status_for(r2.participants[0]).content.includes("Sitting out until mentioned: Sonnet."));
	r2.host_give_floor("Sonnet");
	assert.strictEqual(r2.participants[1].sitting_out, false, "/next brings a model back too");
});

test("sit_out: if everyone sits out, the room goes quiet; /resume brings them all back", async () => {
	let backend = fake_backend((name, req, n) => n === 0
		? {content: [{type: "tool_use", id: `toolu_s${name}`, name: "sit_out", input: {}}], stop_reason: "tool_use", usage: usage()}
		: speak(`${name} ${n}`));
	let room = new_room(make_cfg({host_present: true, max_turns: 6, farewell_round: false}), backend, {template: "x", random: () => 0});
	room.host_say("Hello");
	let run = room.run();
	await until(() => room.quiet);
	assert.strictEqual(turns(room).length, 3);
	assert(room.participants.every(p => p.sitting_out));
	room.host_resume();
	await run;
	assert(turns(room).length === 6 && turns(room).slice(3).every(e => e.action === "speak"));
});

test("open_envelope: several at once, with any that can't be opened reported", () => {
	let {run_utility_tool, new_envelopes} = require("../src/utility_tools");
	let envelopes = new_envelopes();
	let run = (who, name, input) => run_utility_tool({name, input}, who, {envelopes});
	run("Sol", "create_envelope", {label: "a", content: "one"});
	run("Sol", "create_envelope", {label: "b", content: "two"});
	run("Luna", "create_envelope", {label: "c", content: "three", sealed: true});
	let r = run("Sol", "open_envelope", {numbers: [1, 2, 3, 1]});
	assert(!r.is_error);
	assert(r.content.includes("envelope #1 (\"a\")") && r.content.includes("(\"b\"): two"));
	assert(r.content.includes("Not opened: Envelope #3 is sealed: only Luna can open it."));
	assert(r.announce.startsWith("Sol opened 2 envelopes: envelope #1"));
	assert.strictEqual(envelopes.unopened("Luna").length, 1);
	assert(run("Sol", "open_envelope", {numbers: [1]}).content.includes("already open"));
	assert(run("Sol", "open_envelope", {numbers: []}).is_error);
	assert(run("Luna", "open_envelope", {number: 3}).content.includes("three"), "the earlier single-number form still works");
});

test("wait_for_host: nobody speaks until the host does, or /resume lets them start", async () => {
	for (let start of ["say", "resume"]) {
		let backend = fake_backend((name, req, n) => speak(`${name} ${n}`));
		let room = new_room(make_cfg({host_present: true, wait_for_host: true, max_turns: 2, farewell_round: false}), backend, {template: "x", random: () => 0});
		let run = room.run();
		await new Promise(r => setTimeout(r, 30));
		assert.strictEqual(backend.calls.length, 0, "nobody has spoken yet");
		assert.strictEqual(room.state().awaiting_start, true);
		if (start === "say") {
			room.host_say("Hello, everyone.");
		} else {
			room.host_resume();
		}
		await run;
		assert.strictEqual(turns(room).length, 2);
		assert.strictEqual(room.state().awaiting_start, false);
		let first_view = last_user_text(backend.calls[0].req);
		assert.strictEqual(first_view.includes("Hello, everyone."), start === "say", "the host's message is the first thing the models answer");
	}

	let opening = new_room(make_cfg({host_present: true, wait_for_host: true, opening_message: "Hi"}), fake_backend(() => speak("x")), {template: "x"});
	opening.open();
	assert.strictEqual(opening.awaiting_start, false, "an opening message already counts as the host going first");

	let {load_config} = require("../src/config");
	let dir = temp_dir();
	fs.writeFileSync(path.join(dir, "a.txt"), "akey");
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({anthropic_api_key_file: "a.txt", host_present: false, wait_for_host: true,
		models: {Opus: {model: "claude-opus-5-5"}, Haiku: {model: "claude-haiku-5-5"}}}));
	assert.throws(() => load_config(path.join(dir, "config.json")), /wait_for_host needs host_present/);
});

// ------------------------------------------------------------------------------------------------

(async () => {
	let failed = 0;
	for (let t of tests) {
		try {
			let note = await t.fn();
			console.log(`  ok    ${t.name}${note ? ` (${note})` : ""}`);
		} catch (error) {
			failed++;
			let lines = process.env.FULL_ERRORS ? error.stack.split("\n") : error.stack.split("\n").slice(0, 3);
			console.log(`  FAIL  ${t.name}\n        ${lines.join("\n        ")}`);
		}
	}
	console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nAll ${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
