"use strict";

// Terminal front end. Usage: node cli.js [path/to/config.json]

const path = require("path");
const readline = require("readline");
const {load_config, read_api_key} = require("./src/config");
const {new_backend} = require("./src/backend");
const {new_room} = require("./src/room");
const {attach_transcript} = require("./src/transcript");

const COLORS = [36, 33, 35, 32, 34, 31];		// ANSI: cyan, yellow, magenta, green, blue, red.
const USE_COLOR = process.stdout.isTTY;

const HELP = `Type a message and press Enter to say it to the room. @Name gives that model the floor next.

  /pause        Stop handing out the floor (the current speaker finishes first)
  /resume       Carry on; if the room went quiet, everyone may speak again
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

function main() {

	let config_path = path.resolve(process.argv[2] || path.join(__dirname, "config.json"));
	let cfg;
	let api_key;

	try {
		cfg = load_config(config_path);
		api_key = read_api_key(cfg);
	} catch (error) {
		console.error(`Error: ${error.message}`);
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
		} else if (entry.kind === "error") {
			print(paint(`Error${entry.author ? ` (${entry.author})` : ""}: ${entry.text}`, 31));
		} else if (entry.kind === "turn") {
			for (let t of entry.thinking) {
				print(dim(`[${entry.author} thinking] ${t}`));
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

	room.on("state", (s) => {
		if (s.quiet && !was_quiet) {
			print(dim("(The room has gone quiet. Say something, /resume to nudge everyone, or /end.)"));
		}
		if (s.paused && !was_paused) {
			print(dim("(Paused. /resume to carry on.)"));
		}
		was_quiet = s.quiet;
		was_paused = s.paused;
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
