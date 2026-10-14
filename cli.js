"use strict";

// Terminal front end.
//
// Usage: node cli.js [--config path/to/config.json] [--random[=N]] [opening message...]
//
// Any words after the options become the host's opening message, overriding opening_message
// in the config. Use -- before a message that itself starts with a dash.
//
// --random (or -r) adds N words (default 5) picked at random from the config's word_list to
// the opening message, as an optional seed for the conversation.

const USAGE = "Usage: node cli.js [--config path/to/config.json] [--random[=N]] [opening message...]";
const DEFAULT_RANDOM_WORDS = 5;

const path = require("path");
const readline = require("readline");
const {load_config, read_api_key} = require("./src/config");
const {new_backend} = require("./src/backend");
const {new_room} = require("./src/room");
const {attach_transcript} = require("./src/transcript");
const {load_words, pick_words, word_seed_message} = require("./src/words");

const COLORS = [36, 33, 32, 34, 31, 35];		// ANSI: cyan, yellow, green, blue, red, magenta.
const USE_COLOR = process.stdout.isTTY;

const HELP = `Type a message and press Enter to say it to the room. @Name gives that model the floor next.

  /pause        Stop handing out the floor (the current speaker finishes first)
  /resume       Carry on; if the room went quiet, everyone may speak again;
                if a model handed you the floor, let the others carry on instead
  /next Name    Give Name the floor next
  /who          Who is present, and what each has cost
  /cost         Total cost so far
  /end          Close the room, with a farewell round
  /quit         Close immediately, no farewells
  /help         This message

Ctrl+C once is /end, twice is /quit.`;

let rl = null;

function paint(s, code) {
	return USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function dim(s) {
	return paint(s, 2);
}

function print(s) {
	if (rl) {
		readline.clearLine(process.stdout, 0);
		readline.cursorTo(process.stdout, 0);
	}
	process.stdout.write(s + "\n");
	if (rl) {
		rl.prompt(true);
	}
}

function money(n) {
	return "$" + n.toFixed(4);
}

function parse_args(argv) {

	let opts = {config: path.join(__dirname, "config.json"), message: "", random: 0};
	let words = [];

	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		let random_match = /^(?:--random|-r)(?:=(.*))?$/.exec(arg);
		if (arg === "--") {
			words.push(...argv.slice(i + 1));
			break;
		} else if (random_match && words.length === 0) {
			let n = random_match[1] === undefined ? DEFAULT_RANDOM_WORDS : Number(random_match[1]);
			if (!Number.isInteger(n) || n < 1) {
				throw new Error(`${arg}: the number of words must be a whole number, 1 or more`);
			}
			opts.random = n;
		} else if (arg === "--config" || arg === "-c") {
			if (i + 1 >= argv.length) {
				throw new Error(`${arg} needs a path`);
			}
			opts.config = argv[++i];
		} else if (arg === "--help" || arg === "-h") {
			opts.help = true;
		} else if (arg.startsWith("-") && words.length === 0) {
			throw new Error(`Unknown option ${arg} (use -- before a message that starts with a dash)`);
		} else {
			words.push(arg);
		}
	}

	opts.config = path.resolve(opts.config);
	opts.message = words.join(" ").trim();
	return opts;
}

function main() {

	let opts;
	let cfg;
	let api_key;

	try {
		opts = parse_args(process.argv.slice(2));
		if (opts.help) {
			console.log(USAGE);
			process.exit(0);
		}
		cfg = load_config(opts.config);
		api_key = read_api_key(cfg);
		if (opts.message) {
			cfg.opening_message = opts.message;
		}
		if (opts.random) {
			let seed = word_seed_message(pick_words(load_words(cfg.word_list), opts.random));
			cfg.opening_message = cfg.opening_message ? `${cfg.opening_message}\n\n${seed}` : seed;
		}
	} catch (error) {
		console.error(`Error: ${error.message}\n${USAGE}`);
		process.exit(1);
	}

	let room = new_room(cfg, new_backend(api_key));
	let files = attach_transcript(room, cfg);

	let color_of = Object.create(null);
	cfg.participants.forEach((p, i) => {
		color_of[p.name] = COLORS[i % COLORS.length];
	});

	let name_tag = (name) => paint(name, `1;${color_of[name] ?? 37}`);

	room.on("event", (entry) => {
		if (entry.kind === "notice") {
			print(dim(`-- ${entry.text}`));
		} else if (entry.kind === "host") {
			print(`${paint(cfg.host_name, 1)}: ${entry.text}`);
		} else if (entry.kind === "file_op") {
			print(paint(`(${entry.author} ${entry.summary})`, entry.is_error ? 31 : 2));
		} else if (entry.kind === "error") {
			print(paint(`Error${entry.author ? ` (${entry.author})` : ""}: ${entry.text}`, 31));
		} else if (entry.kind === "turn") {
			for (let t of entry.thinking) {
				print(dim(`[${entry.author} thinking] ${t}`));
			}
			if (entry.limit_note) {
				print(dim(`(${entry.author}'s turn ${entry.limit_note})`));
			}
			if (entry.text) {
				print(`${name_tag(entry.author)}: ${entry.text}`);
				if (entry.stop_reason === "max_tokens") {
					print(dim("(cut off at max_tokens)"));
				}
			}
			if (entry.action === "pass") {
				print(dim(`(${entry.author} passed)`));
			} else if (entry.action === "silent") {
				print(dim(`(${entry.author} said nothing; stop reason: ${entry.stop_reason})`));
			}
			if (entry.note_to_host) {
				print(paint(`Note to you from ${entry.author}: ${entry.note_to_host}`, 1));
			}
		}
	});

	room.on("turn_start", ({name}) => {
		print(dim(`(${name} has the floor...)`));
	});

	let was_quiet = false;
	let was_paused = false;
	let was_awaiting = null;

	room.on("state", (s) => {
		if (s.quiet && !was_quiet) {
			print(dim("(The room has gone quiet. Say something, /resume to nudge everyone, or /end.)"));
		}
		if (s.paused && !was_paused) {
			print(dim("(Paused. /resume to carry on.)"));
		}
		if (s.awaiting_host && s.awaiting_host !== was_awaiting) {
			print(dim(`(${s.awaiting_host} has handed you the floor. Say something, or /resume to let the others carry on.)`));
		}
		was_quiet = s.quiet;
		was_paused = s.paused;
		was_awaiting = s.awaiting_host;
	});

	room.on("closed", () => {
		print(dim(`Total cost: ${money(room.total_cost)}${room.cost_known ? "" : " (incomplete)"}`));
		print(dim(`Transcript: ${files.md_path}`));
		if (rl) {
			rl.close();
		}
		process.exit(0);
	});

	print(paint("Discourse", 1) + dim(`: ${cfg.participants.map(p => p.name).join(", ")}. Budget ${cfg.budget > 0 ? money(cfg.budget) : "unlimited"}, ${cfg.max_turns > 0 ? cfg.max_turns : "unlimited"} turns.`));

	let interrupts = 0;

	let on_interrupt = () => {
		interrupts++;
		if (interrupts === 1) {
			print(dim("(Ending with a farewell round. Ctrl+C again to quit at once.)"));
			room.host_end();
		} else {
			room.host_quit();
		}
	};

	if (cfg.host_present) {
		print(dim("Type /help for commands."));
		rl = readline.createInterface({input: process.stdin, output: process.stdout, prompt: "> "});
		rl.on("line", (line) => handle_line(room, cfg, line));
		rl.on("SIGINT", on_interrupt);
		rl.prompt();
	} else {
		print(dim("Running unattended. Ctrl+C to end."));
		process.on("SIGINT", on_interrupt);
	}

	room.run().catch(error => {
		console.error(error);
		process.exit(1);
	});
}

function handle_line(room, cfg, line) {

	let s = line.trim();

	if (!s) {
		rl.prompt();
		return;
	}

	if (!s.startsWith("/")) {
		room.host_say(s);
		if (room.state().in_flight) {
			print(dim("(Your message will appear when the current speaker finishes.)"));
		}
		rl.prompt();
		return;
	}

	let [cmd, ...args] = s.split(/\s+/);

	switch (cmd.toLowerCase()) {
	case "/help":
		print(HELP);
		break;
	case "/pause":
		room.host_pause();
		break;
	case "/resume":
		room.host_resume();
		break;
	case "/next":
		if (!room.host_give_floor(args[0] || "")) {
			print(dim(`(No one present called "${args[0] || ""}".)`));
		}
		break;
	case "/who":
		for (let p of room.participants) {
			print(`${p.name} (${p.cfg.full_name}): ${p.present ? "present" : "left"}, ${p.turns} turns, ${money(p.cost)}`);
		}
		break;
	case "/cost":
		print(`Total: ${money(room.total_cost)}${room.cost_known ? "" : " (incomplete)"} of ${cfg.budget > 0 ? money(cfg.budget) : "unlimited"}`);
		break;
	case "/end":
		room.host_end();
		break;
	case "/quit":
		room.host_quit();
		break;
	default:
		print(dim(`(Unknown command ${cmd}. /help lists them.)`));
	}

	rl.prompt();
}

main();
