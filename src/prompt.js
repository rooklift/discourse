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

function build_system_prompt(cfg, me, template = null) {

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
		"{{date}}": date,
	};

	for (let [key, value] of Object.entries(replacements)) {
		template = template.replaceAll(key, value);
	}

	return template.trim();
}

module.exports = {build_system_prompt};
