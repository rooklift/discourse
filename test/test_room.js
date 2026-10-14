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
	assert.deepStrictEqual(names.slice(0, 2), ["pass", "leave_room"]);
	assert(names.length === 2 || names.length === 7, "either no file tools or all five");
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

test("a model sees others' messages but not their passes, and its own turns as assistant messages", async () => {
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
	assert(!latest.includes("Sonnet"), "Opus doesn't see Sonnet's pass");
	let sonnet_second = backend.calls.filter(c => c.name === "Sonnet")[1].req;
	let after_pass = sonnet_second.messages[sonnet_second.messages.length - 1].content;
	assert.strictEqual(after_pass[0].type, "tool_result", "Sonnet's pass gets a tool_result");
	assert.strictEqual(after_pass[0].content, "You passed.");
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
	assert(present.includes("The same goes for @Host: the room will wait for their reply."));
	assert(present.includes("Host may join in now and then") && !present.includes("isn't watching"));
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

	assert.strictEqual(fs.readFileSync(path.join(root, "Opus", "notes.md"), "utf8"), "kept");
	assert.strictEqual(at_close.turns, 1, "the interrupted turn was logged before 'closed' fired");
	assert.strictEqual(at_close.turn_count, 1);
	assert.deepStrictEqual(turns(room)[0].file_ops.map(o => o.summary), ["created notes.md (4 bytes)"]);
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
	assert(!fs.existsSync(path.join(root, "Opus", "late.md")), "no file tool ran after the room closed");
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

		r = with_write_sync(fake, () => run_file_tool(st, tool("write_file", {filename: "keep.md", content: "overwritten"}), "t"));
		assert.strictEqual(r.is_error, true);
		assert.strictEqual(st.read("keep.md").text, "precious words", "rewrite failure left the original intact");

		r = with_write_sync(fake, () => run_file_tool(st, tool("write_file", {filename: "new.md", content: "half"}), "t"));
		assert.strictEqual(r.is_error, true);
		assert(!st.exists("new.md"), "a failed new file isn't left half written");

		assert.deepStrictEqual(leftovers(st), [], "no temporary files left behind");
	}
	assert.deepStrictEqual(st.files().map(f => f.name), ["keep.md"]);
});

test("storage: temporary files left by a crash are cleared, and never listed", () => {
	let root = temp_dir();
	let st = new_storage(root, "Opus");
	fs.writeFileSync(path.join(st.folder, ".tmp-0123456789abcdef"), "debris");
	assert.deepStrictEqual(st.files(), [], "not listed");
	assert.throws(() => st.read(".tmp-0123456789abcdef"), /Invalid filename/, "not nameable");
	new_storage(root, "Opus");
	assert.deepStrictEqual(leftovers(st), [], "cleared when the folder is next opened");
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
					log: room.log.some(e => e.kind === "file_op" && e.summary === "created notes.md (5 bytes)"),
					md: fs.readFileSync(files.md_path, "utf8").includes("Opus created notes.md (5 bytes)"),
					jsonl: fs.readFileSync(files.jsonl_path, "utf8").includes("\"kind\":\"file_op\""),
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
	assert.deepStrictEqual(t[0].file_ops.map(o => o.summary), ["created notes.md (20 bytes)"]);
	assert.strictEqual(fs.readFileSync(path.join(root, "Opus", "notes.md"), "utf8"), "Remember the badger.");
	assert(fs.existsSync(path.join(root, "Sonnet")) && fs.existsSync(path.join(root, "Haiku")), "every model gets a folder");

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
	let room = new_room(make_cfg({storage_dir: temp_dir(), max_turns: 3, farewell_round: false}), backend, {template: "x", random: () => 0});
	await room.run();
	let t = turns(room);
	assert.strictEqual(t[0].steps.length, 10);
	assert.strictEqual(t[0].limit_note, "stopped after 10 steps");
	assert.strictEqual(t[0].action, "silent");
	assert.strictEqual(t.length, 3, "the room carried on");
	assert.strictEqual(t[1].author, "Sonnet");
	let opus_after = backend.calls.filter(c => c.name === "Opus")[10];
	assert(opus_after, "Opus was asked again, with all 10 steps replayed in a valid request");
	assert.strictEqual(opus_after.req.messages.filter(m => m.role === "assistant").length, 10);
});

test("the system prompt describes the folder and lists its contents at the start", () => {
	let root = temp_dir();
	new_storage(root, "Sonnet").write("diary.md", "Day one.", "Claude Sonnet 5.5 (claude-sonnet-5-5)");
	let cfg = make_cfg({storage_dir: root, system_prompt: path.join(__dirname, "..", "system", "standard.txt")});
	let room = new_room(cfg, fake_backend(() => speak("x")));
	let s = room.participants[1].system;
	assert(s.includes("You have a folder of your own"));
	assert(s.includes("- diary.md (8 bytes"));
	assert(s.includes("last written by Claude Sonnet 5.5 (claude-sonnet-5-5)"));
	assert(room.participants[0].system.includes("(empty)"));
	let without = new_room(make_cfg({system_prompt: cfg.system_prompt}), fake_backend(() => speak("x")));
	assert(!without.participants[0].system.includes("folder of your own"));
	assert(!without.participants[0].system.includes("{{"));
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
			console.log(`  FAIL  ${t.name}\n        ${error.stack.split("\n").slice(0, 3).join("\n        ")}`);
		}
	}
	console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nAll ${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
