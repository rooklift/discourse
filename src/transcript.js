"use strict";

// Writes two files per session, appending as events happen so nothing is lost on a crash:
//   <stamp>.jsonl   Everything, including raw content blocks, usage and costs. One JSON object per line.
//   <stamp>.md      A readable transcript.

const fs = require("fs");
const path = require("path");

function stamp(d = new Date()) {
	let pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function attach_transcript(room, cfg) {

	fs.mkdirSync(cfg.transcript_dir, {recursive: true});

	let base = path.join(cfg.transcript_dir, stamp());
	let jsonl_path = base + ".jsonl";
	let md_path = base + ".md";

	let write_json = (o) => fs.appendFileSync(jsonl_path, JSON.stringify(o) + "\n");
	let write_md = (s) => fs.appendFileSync(md_path, s);

	write_json({
		kind: "meta",
		time: new Date().toISOString(),
		config: Object.assign({}, cfg, {participants: cfg.participants.map(p => Object.assign({}, p, {price_tiers: undefined}))}),
		system_prompts: Object.fromEntries(room.participants.map(p => [p.name, p.system])),
	});

	let names = cfg.participants.map(p => `${p.name} (${p.full_name})`).join(", ");
	write_md(`# Discourse, ${new Date().toLocaleString("en-US")}\n\nParticipants: ${names}, and ${cfg.host_name} (host).\n\n---\n\n`);

	room.on("event", (entry) => {
		write_json(entry);
		write_md(markdown_for(entry, cfg));
	});

	room.on("closed", () => {
		let lines = room.participants.map(p => {
			let u = p.usage;
			return `- ${p.name}: ${p.turns} turns, $${p.cost.toFixed(4)} (input ${u.input}, cache read ${u.cache_read}, cache write ${u.cache_write}, output ${u.output})`;
		});
		let total = `$${room.total_cost.toFixed(4)}${room.cost_known ? "" : " (incomplete: some prices unknown)"}`;
		write_md(`---\n\nTotal cost: ${total}\n\n${lines.join("\n")}\n`);
		write_json({kind: "summary", total_cost: room.total_cost, cost_known: room.cost_known, participants: room.participants.map(p => ({name: p.name, turns: p.turns, cost: p.cost, usage: p.usage}))});
	});

	return {jsonl_path, md_path};
}

function markdown_for(entry, cfg) {

	if (entry.kind === "notice") {
		return `> *${entry.text}*\n\n`;
	}

	if (entry.kind === "host") {
		return `**${cfg.host_name}** (host)\n\n${entry.text}\n\n`;
	}

	if (entry.kind === "error") {
		return `> *Error${entry.author ? ` (${entry.author})` : ""}: ${entry.text}*\n\n`;
	}

	if (entry.kind !== "turn") {
		return "";
	}

	let s = "";

	for (let t of entry.thinking) {
		s += `<details><summary>${entry.author} thinking</summary>\n\n${t}\n\n</details>\n\n`;
	}

	if (entry.text) {
		s += `**${entry.author}**\n\n${entry.text}\n\n`;
		if (entry.stop_reason === "max_tokens") {
			s += "*(cut off at max_tokens)*\n\n";
		}
	}

	if (entry.action === "pass") {
		s += `> *${entry.author} passed.*\n\n`;
	} else if (entry.action === "silent") {
		s += `> *${entry.author} said nothing (stop reason: ${entry.stop_reason}).*\n\n`;
	}

	if (entry.note_to_host) {
		s += `> *Note to ${cfg.host_name} from ${entry.author}: ${entry.note_to_host}*\n\n`;
	}

	return s;
}

module.exports = {attach_transcript};
