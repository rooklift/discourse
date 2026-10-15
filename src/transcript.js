"use strict";

// Writes two files per session, appending as events happen so nothing is lost on a crash:
//   <stamp>.jsonl   Everything, including raw content blocks, usage and costs. One JSON object per line.
//   <stamp>.md      A readable transcript.
// plus, if the host shares images, a <stamp>-images folder holding each image as sent.

const fs = require("fs");
const path = require("path");

function stamp(d = new Date()) {
	let pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function attach_transcript(room, cfg) {

	fs.mkdirSync(cfg.transcript_dir, {recursive: true});

	let session = stamp();
	let base = path.join(cfg.transcript_dir, session);
	let jsonl_path = base + ".jsonl";
	let md_path = base + ".md";
	let images_dir = base + "-images";
	let images_rel = session + "-images";

	let write_json = (o) => fs.appendFileSync(jsonl_path, JSON.stringify(o) + "\n");
	let write_md = (s) => fs.appendFileSync(md_path, s);

	write_json({
		kind: "meta",
		time: new Date().toISOString(),
		config: Object.assign({}, cfg, {
			participants: cfg.participants.map(p => Object.assign({}, p, {price_tiers: undefined})),
			opening_images: (cfg.opening_images || []).map(im => im.source),		// Names only; the images are saved below.
			opening_files: (cfg.opening_files || []).map(f => f.name),			// Names only; the text is in the host entry.
		}),
		system_prompts: Object.fromEntries(room.participants.map(p => [p.name, p.system])),
	});

	let names = cfg.participants.map(p => `${p.name} (${p.full_name})`).join(", ");
	write_md(`# Discourse, ${new Date().toLocaleString("en-US")}\n\nParticipants: ${names}, and ${cfg.host_name} (host).\n\n---\n\n`);

	// Images are saved as files and referenced by name, so the transcripts stay small.

	let save_images = (entry) => {
		if (entry.kind !== "host" || !entry.images || entry.images.length === 0) {
			return entry;
		}
		fs.mkdirSync(images_dir, {recursive: true});
		let images = entry.images.map(im => {
			let file = `image-${im.number}.${im.media_type === "image/png" ? "png" : "jpg"}`;
			fs.writeFileSync(path.join(images_dir, file), Buffer.from(im.data, "base64"));
			return {number: im.number, file: `${images_rel}/${file}`, source: im.source, media_type: im.media_type, width: im.width, height: im.height, tokens: im.tokens};
		});
		return Object.assign({}, entry, {images});
	};

	room.on("event", (entry) => {
		let saved = save_images(entry);
		write_json(saved);
		write_md(markdown_for(saved, cfg));
	});

	room.on("closed", () => {
		let lines = room.participants.map(p => {
			let u = p.usage;
			return `- ${p.name}: ${p.turns} turns, $${p.cost.toFixed(2)} (input ${u.input}, cache read ${u.cache_read}, cache write ${u.cache_write}, output ${u.output})`;
		});
		let total = `$${room.total_cost.toFixed(2)}${room.cost_known ? "" : " (incomplete: some prices unknown)"}`;
		let groups = room.cost_by_provider();
		let split = groups.length > 1
			? ` (${groups.map(g => `${g.company} $${g.cost.toFixed(2)}${g.known ? "" : " incomplete"}`).join(", ")})`
			: "";
		write_md(`---\n\nTotal cost: ${total}${split}\n\n${lines.join("\n")}\n`);
		write_json({kind: "summary", total_cost: room.total_cost, cost_known: room.cost_known, providers: groups,
			participants: room.participants.map(p => ({name: p.name, turns: p.turns, cost: p.cost, usage: p.usage}))});
	});

	return {jsonl_path, md_path};
}

function markdown_for(entry, cfg) {

	if (entry.kind === "notice") {
		return `> *${entry.text}*\n\n`;
	}

	if (entry.kind === "host") {
		let s = `**${cfg.host_name}** (host)\n\n`;
		for (let im of entry.images || []) {
			s += `![Image ${im.number}: ${im.source}](${encodeURI(im.file)})\n\n`;
		}
		if (entry.text) {
			s += `${entry.text}\n\n`;
		}
		for (let f of entry.files || []) {
			s += `<details open><summary>File: ${f.name}</summary>\n\n${f.text}\n\n</details>\n\n`;
		}
		return s;
	}

	if (entry.kind === "tool_op") {
		return `> *${entry.author} ${entry.summary}.*\n\n`;
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

	if (entry.limit_note) {
		s += `> *${entry.author}'s turn ${entry.limit_note}.*\n\n`;
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
