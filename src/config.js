"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const pricing = require("./pricing");

const DEFAULTS = {
	anthropic_api_key_file: "",		// Path to a file containing only your Anthropic API key. Keep it outside the repo.
	google_api_key_file: "",		// The same for a Gemini API key, if any participant is a Gemini model.
	host_name: "Host",				// What the models call you.
	host_present: true,				// If false, the room runs unattended and closes when it goes quiet.
	system_prompt: "./system/standard.txt",
	transcript_dir: "./transcripts",
	word_list: "./words.txt",		// One word per line; used by the CLI's --random option.
	storage_dir: "./storage",		// A private folder per model (named by model ID), plus "shared", kept between sessions. "" turns this off.
	show_thinking: false,			// Ask the API for thinking summaries, show them to the host and save them.
	opening_message: "",			// Optional first message from the host.
	first_speaker: "",				// Optional name of the participant who speaks first. Random if blank.
	floor_randomness: 0.25,			// Chance (0-1) that an unaddressed floor goes to a random eligible model.
	max_turns: 60,					// Model turns before the room starts closing. 0 = no limit.
	budget: 2,						// Dollars. The room starts closing at 90% of this. 0 = no limit.
	farewell_round: true,			// Give each model a last turn before the room closes.
	cache_ttl: "5m",				// "5m" or "1h". Use "1h" if turns are often more than 5 minutes apart.
	participants: [],
};

const PARTICIPANT_DEFAULTS = {
	name: "",						// Required. Short name used in the room, e.g. "Opus". Used for @mentions.
	model: "",						// Required. API model ID, e.g. "claude-opus-5-5" or "gemini-3.8-flash".
	provider: "",					// "anthropic" or "google". Worked out from the model ID if blank.
	full_name: "",					// Shown to the other models, e.g. "Claude Opus 5.5". Defaults to the model ID.
	company: "",					// Shown to the other models. Defaults to the provider's company.
	max_tokens: 16000,				// Hard limit on thinking + reply, per turn. (Gemini models allow up to 65,536.)
	effort: "",						// See PROVIDERS below for the choices; "" for the model's default.
	prices: null,					// Optional override of the built-in price table.
};

// Per provider: what "effort" may be set to, the company behind it, and the config key for its
// API key file. For Gemini models, effort is the thinking level.

const PROVIDERS = {
	anthropic: {company: "Anthropic", key_file: "anthropic_api_key_file", efforts: ["", "low", "medium", "high", "xhigh", "max"]},
	google: {company: "Google", key_file: "google_api_key_file", efforts: ["", "minimal", "low", "medium", "high"]},
};

function provider_for(model) {
	return /^gemini-/i.test(model) ? "google" : "anthropic";
}

function expand_home(p) {
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
		return path.join(os.homedir(), p.slice(1));
	}
	return p;
}

// Relative paths in the config are relative to the config file's own directory.

function resolve_path(p, base_dir) {
	p = expand_home(p);
	return path.isAbsolute(p) ? p : path.resolve(base_dir, p);
}

function check_keys(obj, allowed, where) {
	for (let key of Object.keys(obj)) {
		if (!Object.hasOwn(allowed, key)) {
			throw new Error(`Unknown key "${key}" in ${where}`);
		}
	}
}

function load_config(config_path) {

	if (!fs.existsSync(config_path)) {
		throw new Error(`Config file not found: ${config_path} (copy config.json.example to get started)`);
	}

	let raw = JSON.parse(fs.readFileSync(config_path, "utf8"));
	let base_dir = path.dirname(path.resolve(config_path));

	if (Object.hasOwn(raw, "api_key_file")) {
		throw new Error("\"api_key_file\" has been renamed \"anthropic_api_key_file\"; please rename it in your config");
	}

	check_keys(raw, DEFAULTS, "config");
	let cfg = Object.assign({}, DEFAULTS, raw);

	// Paths written in the config are relative to the config file. Defaults are relative to the
	// program itself, so a config kept elsewhere still finds the bundled prompt and word list.

	let app_dir = path.resolve(__dirname, "..");
	for (let key of ["anthropic_api_key_file", "google_api_key_file", "system_prompt", "transcript_dir", "word_list", "storage_dir"]) {
		if (["anthropic_api_key_file", "google_api_key_file", "storage_dir"].includes(key) && !cfg[key]) {
			continue;							// Empty: not used (or, for storage, turned off).
		}
		cfg[key] = resolve_path(cfg[key], Object.hasOwn(raw, key) ? base_dir : app_dir);
	}

	if (!["5m", "1h"].includes(cfg.cache_ttl)) {
		throw new Error("cache_ttl must be \"5m\" or \"1h\"");
	}
	if (typeof cfg.floor_randomness !== "number" || cfg.floor_randomness < 0 || cfg.floor_randomness > 1) {
		throw new Error("floor_randomness must be a number from 0 to 1");
	}

	if (!Array.isArray(cfg.participants) || cfg.participants.length < 2) {
		throw new Error("config needs at least two participants");
	}

	let seen = Object.create(null);
	let seen_models = Object.create(null);

	cfg.participants = cfg.participants.map((p, i) => {
		check_keys(p, PARTICIPANT_DEFAULTS, `participant ${i + 1}`);
		let o = Object.assign({}, PARTICIPANT_DEFAULTS, p);
		if (!o.name || !o.model) {
			throw new Error(`participant ${i + 1} needs a "name" and a "model"`);
		}
		if (!/^[A-Za-z0-9_-]+$/.test(o.name)) {
			throw new Error(`participant name "${o.name}" should be one word (letters, digits, _ or -) so @mentions work`);
		}
		let lower = o.name.toLowerCase();
		if (seen[lower] || lower === cfg.host_name.toLowerCase()) {
			throw new Error(`participant name "${o.name}" is used twice (or clashes with host_name)`);
		}
		seen[lower] = true;

		// Each model's private folder is named after its model ID, so with storage on, the ID
		// must make a safe folder name, and a model can take only one seat: two seats would share
		// a folder that each was told is private.

		if (cfg.storage_dir) {
			let model = o.model.toLowerCase();
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.model) || o.model.endsWith(".") || model === "shared") {
				throw new Error(`model "${o.model}" can't be used as a storage folder name; set storage_dir to "" to use it`);
			}
			if (seen_models[model]) {
				throw new Error(`${seen_models[model]} and ${o.name} are both ${o.model}. Each model has one private folder, so with storage on, a model can take only one seat (set storage_dir to "" to seat it twice)`);
			}
			seen_models[model] = o.name;
		}

		o.provider = o.provider || provider_for(o.model);
		let provider = Object.hasOwn(PROVIDERS, o.provider) ? PROVIDERS[o.provider] : null;
		if (!provider) {
			throw new Error(`participant ${o.name}: provider must be one of ${Object.keys(PROVIDERS).map(k => JSON.stringify(k)).join(", ")}`);
		}
		if (!provider.efforts.includes(o.effort)) {
			throw new Error(`participant ${o.name}: effort must be one of ${provider.efforts.map(e => JSON.stringify(e)).join(", ")}`);
		}
		if (!cfg[provider.key_file]) {
			throw new Error(`participant ${o.name} is a model from ${provider.company}, so the config needs "${provider.key_file}": the path to a file containing your ${provider.company} API key`);
		}
		o.company = o.company || provider.company;
		o.full_name = o.full_name || o.model;
		o.price_tiers = pricing.tiers_for(o.model, o.prices);
		if (!o.price_tiers && cfg.budget > 0) {
			throw new Error(`No known prices for ${o.model}; add a "prices" object for it, or set budget to 0`);
		}
		return o;
	});

	if (cfg.first_speaker && !cfg.participants.some(p => p.name === cfg.first_speaker)) {
		throw new Error(`first_speaker "${cfg.first_speaker}" is not a participant`);
	}

	return cfg;
}

function read_key_file(file) {
	if (!fs.existsSync(file)) {
		throw new Error(`API key file not found: ${file}`);
	}
	let key = fs.readFileSync(file, "utf8").trim();
	if (!key) {
		throw new Error(`API key file is empty: ${file}`);
	}
	return key;
}

// Returns {provider: key} for each provider some participant uses.

function read_api_keys(cfg) {
	let keys = {};
	for (let p of cfg.participants) {
		if (!keys[p.provider]) {
			keys[p.provider] = read_key_file(cfg[PROVIDERS[p.provider].key_file]);
		}
	}
	return keys;
}

module.exports = {load_config, read_api_keys, PROVIDERS};
