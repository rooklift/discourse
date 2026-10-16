"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const pricing = require("./pricing");

const DEFAULTS = {
	anthropic_api_key_file: "",		// Path to a file containing only your Anthropic API key. Keep it outside the repo.
	google_api_key_file: "",		// The same for a Gemini API key, if any participant is a Gemini model.
	openai_api_key_file: "",		// The same for an OpenAI API key, if any participant is an OpenAI model.
	host_name: "Host",				// What the models call you.
	host_present: true,				// If false, the room runs unattended and closes when it goes quiet.
	system_prompt: "./system/standard.txt",
	transcript_dir: "./transcripts",
	word_list: "./words.txt",		// One word per line; used by the CLI's --random option.
	storage_dir: "./storage",		// A private folder per model (named by model ID), plus "shared", kept between sessions. "" turns this off.
	show_thinking: false,			// Ask the API for thinking summaries, show them to the host and save them.
	opening_message: "",			// Optional first message from the host.
	wait_for_host: false,			// With no opening message, wait for the host to speak first (needs host_present).
	first_speaker: "",				// Optional name of the model who speaks first. Random if blank.
	floor_randomness: 0.25,			// Chance (0-1) that an unaddressed floor goes to a random eligible model.
	max_turns: 60,					// Model turns before the room starts closing. 0 = no limit.
	budget: 2,						// Dollars. The room starts closing at 90% of this. 0 = no limit.
	farewell_round: true,			// Give each model a last turn before the room closes.
	cache_ttl: "5m",				// "5m" or "1h". Use "1h" if turns are often more than 5 minutes apart.
	models: {},						// Every model you might seat, keyed by its name in the room (e.g. "Opus").
	active: [],						// Names of the models in this session. Empty means all of them.
};

// Each entry in "models". Its key is the name used in the room, and for @mentions.

const MODEL_DEFAULTS = {
	model: "",						// Required. API model ID, e.g. "claude-opus-5-5", "gemini-3.8-flash" or "gpt-6.1-sol".
	provider: "",					// "anthropic", "google" or "openai". Worked out from the model ID if blank.
	full_name: "",					// Shown to the other models, e.g. "Claude Opus 5.5". Defaults to the model ID.
	company: "",					// Shown to the other models. Defaults to the provider's company.
	max_tokens: 16000,				// Hard limit on thinking + reply, per turn. (Gemini models allow up to 65,536.)
	effort: "",						// See PROVIDERS below for the choices; "" for the model's default.
	prices: null,					// Optional override of the built-in price table.
};

// Per provider: what "effort" may be set to, the company behind it, and the config key for its
// API key file. For Gemini models, effort is the thinking level; for OpenAI, the reasoning effort.
// Not every model takes every value: the API says so if one doesn't.

const PROVIDERS = {
	anthropic: {company: "Anthropic", key_file: "anthropic_api_key_file", efforts: ["", "low", "medium", "high", "xhigh", "max"]},
	google: {company: "Google", key_file: "google_api_key_file", efforts: ["", "minimal", "low", "medium", "high"]},
	openai: {company: "OpenAI", key_file: "openai_api_key_file", efforts: ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"]},
};

function provider_for(model) {
	if (/^gemini-/i.test(model)) {
		return "google";
	}
	if (/^(gpt-|o\d|chatgpt-|chat-latest)/i.test(model)) {
		return "openai";
	}
	return "anthropic";
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

// opts.active: names to seat this session, overriding the config's "active" (the CLI's --active).

function load_config(config_path, opts = {}) {

	if (!fs.existsSync(config_path)) {
		throw new Error(`Config file not found: ${config_path} (copy config.json.example to get started)`);
	}

	let raw = JSON.parse(fs.readFileSync(config_path, "utf8"));
	let base_dir = path.dirname(path.resolve(config_path));

	if (Object.hasOwn(raw, "api_key_file")) {
		throw new Error("\"api_key_file\" has been renamed \"anthropic_api_key_file\"; please rename it in your config");
	}
	if (Object.hasOwn(raw, "participants")) {
		throw new Error("\"participants\" has been replaced by \"models\", an object mapping each name to its settings, plus \"active\", a list of the names in this session. See config.json.example");
	}

	check_keys(raw, DEFAULTS, "config");
	let cfg = Object.assign({}, DEFAULTS, raw);

	// Paths written in the config are relative to the config file. Defaults are relative to the
	// program itself, so a config kept elsewhere still finds the bundled prompt and word list.

	let app_dir = path.resolve(__dirname, "..");
	let key_files = Object.values(PROVIDERS).map(pr => pr.key_file);
	for (let key of key_files.concat(["system_prompt", "transcript_dir", "word_list", "storage_dir"])) {
		if ((key_files.includes(key) || key === "storage_dir") && !cfg[key]) {
			continue;							// Empty: not used (or, for storage, turned off).
		}
		cfg[key] = resolve_path(cfg[key], Object.hasOwn(raw, key) ? base_dir : app_dir);
	}

	if (cfg.wait_for_host && !cfg.host_present) {
		throw new Error("wait_for_host needs host_present: true, or nobody would ever speak first");
	}
	if (!["5m", "1h"].includes(cfg.cache_ttl)) {
		throw new Error("cache_ttl must be \"5m\" or \"1h\"");
	}
	if (typeof cfg.floor_randomness !== "number" || cfg.floor_randomness < 0 || cfg.floor_randomness > 1) {
		throw new Error("floor_randomness must be a number from 0 to 1");
	}

	// Every entry in "models" is checked, seated or not, so a typo shows up straight away. Key
	// files, prices and storage folders are only needed for the models actually seated.

	if (!cfg.models || typeof cfg.models !== "object" || Array.isArray(cfg.models)) {
		throw new Error("\"models\" should be an object mapping each name to its settings, e.g. {\"Opus\": {\"model\": \"claude-opus-5-5\"}}");
	}

	let seen = Object.create(null);
	let all = Object.entries(cfg.models).map(([name, settings]) => {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new Error(`model name "${name}" should be one word (letters, digits, _ or -) so @mentions work`);
		}
		let lower = name.toLowerCase();
		if (seen[lower] || lower === cfg.host_name.toLowerCase()) {
			throw new Error(`model name "${name}" is used twice (or clashes with host_name)`);
		}
		seen[lower] = name;
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
			throw new Error(`models.${name} should be an object of settings`);
		}
		check_keys(settings, MODEL_DEFAULTS, `models.${name}`);
		let o = Object.assign({name}, MODEL_DEFAULTS, settings);
		if (!o.model) {
			throw new Error(`models.${name} needs a "model" (the API model ID)`);
		}
		o.provider = o.provider || provider_for(o.model);
		let provider = Object.hasOwn(PROVIDERS, o.provider) ? PROVIDERS[o.provider] : null;
		if (!provider) {
			throw new Error(`${name}: provider must be one of ${Object.keys(PROVIDERS).map(k => JSON.stringify(k)).join(", ")}`);
		}
		if (!provider.efforts.includes(o.effort)) {
			throw new Error(`${name}: effort must be one of ${provider.efforts.map(e => JSON.stringify(e)).join(", ")}`);
		}
		o.company = o.company || provider.company;
		o.full_name = o.full_name || o.model;
		return o;
	});

	let active = opts.active ?? cfg.active;
	if (!Array.isArray(active) || active.some(n => typeof n !== "string")) {
		throw new Error("\"active\" should be a list of model names");
	}
	if (active.length === 0) {
		active = all.map(o => o.name);
	}
	let seated = [];
	for (let n of active) {
		let canonical = seen[n.toLowerCase()];
		if (!canonical) {
			throw new Error(`"${n}" is in "active" but not in "models" (which has ${all.map(o => o.name).join(", ") || "nothing"})`);
		}
		if (seated.includes(canonical)) {
			throw new Error(`"${canonical}" is listed twice in "active"`);
		}
		seated.push(canonical);
	}
	if (seated.length < 2) {
		throw new Error("a room needs at least two active models");
	}
	cfg.active = seated;

	let seen_models = Object.create(null);

	cfg.participants = seated.map(name => all.find(o => o.name === name)).map(o => {
		let provider = PROVIDERS[o.provider];

		// Each model's private folder is named after its model ID, so with storage on, the ID
		// must make a safe folder name, and a model can take only one seat: two seats would share
		// a folder that each was told is private.

		if (cfg.storage_dir) {
			let model = o.model.toLowerCase();
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(o.model) || o.model.endsWith(".") || model === "shared") {
				throw new Error(`${o.name}'s model "${o.model}" can't be used as a storage folder name; set storage_dir to "" to use it`);
			}
			if (seen_models[model]) {
				throw new Error(`${seen_models[model]} and ${o.name} are both ${o.model}. Each model has one private folder, so with storage on, a model can take only one seat (set storage_dir to "" to seat it twice)`);
			}
			seen_models[model] = o.name;
		}

		if (!cfg[provider.key_file]) {
			throw new Error(`${o.name} is a model from ${provider.company}, so the config needs "${provider.key_file}": the path to a file containing your ${provider.company} API key`);
		}
		o.price_tiers = pricing.tiers_for(o.model, o.prices);
		if (!o.price_tiers && cfg.budget > 0) {
			throw new Error(`No known prices for ${o.model}; add a "prices" object for it, or set budget to 0`);
		}
		return o;
	});

	if (cfg.first_speaker) {
		let first = cfg.participants.find(p => p.name.toLowerCase() === String(cfg.first_speaker).toLowerCase());
		if (!first) {
			throw new Error(`first_speaker "${cfg.first_speaker}" isn't one of the active models`);
		}
		cfg.first_speaker = first.name;
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

// Returns {provider: key} for each provider an active model uses.

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
