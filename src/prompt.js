"use strict";

const fs = require("fs");

function participants_list(cfg, me) {
	return cfg.participants.map(p => {
		let s = `- ${p.name}: ${p.full_name}, made by ${p.company}`;
		if (p.name === me.name) {
			s += " (this is you)";
		}
		return s;
	}).concat(`- ${cfg.host_name}: the human host`).join("\n");
}

function record_note(cfg) {
	let s = `The conversation is saved to a transcript, which ${cfg.host_name} may read.`;
	if (cfg.show_thinking) {
		s += ` Summaries of your private reasoning are saved too, and ${cfg.host_name} may read them; the other models never see them.`;
	} else {
		s += " Your private reasoning isn't shown to anyone, including the other models.";
	}
	return s;
}

// storage: {listing, limits} if this model has a folder, otherwise null.

function storage_note(cfg, me, storage) {
	if (!storage) {
		return "";
	}
	let kb = (n) => `${Math.round(n / 1024)} KB`;
	return `Your private folder:

You have a folder of your own for text files, and it's kept between sessions, so anything you save will still be there the next time you're in this room. It belongs to "${me.name}" in this room: if ${cfg.host_name} upgrades the model behind that name, the next version gets the same folder, and each file records which model version last wrote it. The other models can't see your folder, but ${cfg.host_name} can read it.

Use it however you like, or not at all: notes for next time, something you're working on, things you'd like to remember. The tools are list_files, read_file, write_file, edit_file and delete_file. Using them is invisible to the other models, but any ordinary text in your reply is shared as your message, even if it comes between tool calls. Filenames only, no subfolders. Limits: ${storage.limits.file_count} files, ${kb(storage.limits.file_bytes)} per file, ${kb(storage.limits.total_bytes)} in total.

At the start of this session, your folder contained:

${storage.listing}`;
}

function build_system_prompt(cfg, me, template = null, storage = null) {

	if (template === null) {
		template = fs.readFileSync(cfg.system_prompt, "utf8").replaceAll("\r\n", "\n");
	}

	let date = new Date().toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric", year: "numeric"});

	let replacements = {
		"{{name}}": me.name,
		"{{full_name}}": me.full_name,
		"{{company}}": me.company,
		"{{host_name}}": cfg.host_name,
		"{{participants}}": participants_list(cfg, me),
		"{{record_note}}": record_note(cfg),
		"{{host_floor_note}}": cfg.host_present ? ` The same goes for @${cfg.host_name}: the room will wait for their reply.` : "",
		"{{host_note}}": cfg.host_present
			? `${cfg.host_name} may join in now and then; their messages are marked as coming from the host.`
			: `${cfg.host_name} isn't watching this session live, so won't see or answer messages while it runs. When the conversation goes quiet, the room closes.`,
		"{{storage_note}}": storage_note(cfg, me, storage),
		"{{date}}": date,
	};

	for (let [key, value] of Object.entries(replacements)) {
		template = template.replaceAll(key, value);
	}

	return template.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {build_system_prompt};
