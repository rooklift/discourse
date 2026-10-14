"use strict";

// Random words from a list, as an optional seed for the conversation.

const fs = require("fs");

function load_words(filepath) {
	if (!fs.existsSync(filepath)) {
		throw new Error(`Word list not found: ${filepath}`);
	}
	let words = fs.readFileSync(filepath, "utf8")
		.split(/\r?\n/)
		.map(s => s.trim())
		.filter(s => s && !s.startsWith("#"));
	return [...new Set(words)];
}

// n distinct words, chosen uniformly (partial Fisher-Yates shuffle).

function pick_words(words, n, random = Math.random) {
	let pool = words.slice();
	n = Math.min(n, pool.length);
	for (let i = 0; i < n; i++) {
		let j = i + Math.floor(random() * (pool.length - i));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	return pool.slice(0, n);
}

function word_seed_message(words) {
	let list = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0];
	let one = words.length === 1;
	let intro = one ? "Here's a randomly selected word" : `Here are ${words.length} randomly selected words`;
	let it = one ? "it" : "them";
	return `${intro}, as food for thought if you'd like some: ${list}. Use ${it} or ignore ${it}, as you like.`;
}

module.exports = {load_words, pick_words, word_seed_message};
