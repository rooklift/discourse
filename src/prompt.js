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
	let s = `Everything that happens here, including your use of tools, is saved to a transcript that ${cfg.host_name} may read. When something is described as private, that means private from the other models.`;
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
	return `Your folders:

You have a private folder of your own for text files, and it's kept between sessions, so anything you save will still be there the next time you're in this room. It belongs to your model, ${me.model}, rather than to your name here: whatever name you have in a future session, you'll find the same folder, while any other model, including a newer version of you, gets a folder of its own. Each file records which model last wrote it. The other models can't see your private folder, but ${cfg.host_name} can read it.

There is also one shared folder, kept between sessions too, which every model in the room can read and write: for things you make together, or leave for each other. When someone changes a shared file, the others get a notice saying so.

Use them however you like, or not at all. The tools are list_files, read_file, search_files, write_file, append_file, edit_file and delete_file; each takes folder "private" (the default) or "shared". Using them is private from the other models, apart from those notices about shared files, but any ordinary text in your reply is shared as your message, even if it comes between tool calls. To replace an existing file with write_file you need to have read it in this session, unless you set overwrite. Filenames only, no subfolders. Limits per folder: ${storage.limits.file_count} files, ${kb(storage.limits.file_bytes)} per file, ${kb(storage.limits.total_bytes)} in total.

At the start of this session, your private folder contained:

${storage.listing}

And the shared folder contained:

${storage.shared_listing}`;
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
			? `${cfg.host_name} may join in now and then, and sometimes share an image; their messages are marked as coming from the host.`
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
