"use strict";

// Reads a text file the host wants to share with the room as part of a message.

const fs = require("fs");
const path = require("path");

const MAX_CHARS = 50000;					// About 12,000 tokens; every model rereads it each turn (cached).
const MAX_BYTES = 1024 * 1024;				// Checked before reading, so a huge file is refused quickly.

// Returns {name, text, lines, tokens}. tokens is a rough estimate (about 4 characters each).

function prepare_text_file(filepath) {

	if (typeof filepath !== "string" || !filepath.trim()) {
		throw new Error("No file given.");
	}
	let full = path.resolve(filepath);
	let st;
	try {
		st = fs.statSync(full);
	} catch (error) {
		throw new Error(`File not found: ${full}`);
	}
	if (!st.isFile()) {
		throw new Error(`Not a file: ${full}`);
	}
	if (st.size > MAX_BYTES) {
		throw new Error(`File is too large (${Math.round(st.size / 1024)} KB; text files can be at most ${MAX_CHARS} characters).`);
	}

	let buffer = fs.readFileSync(full);
	if (buffer.includes(0)) {
		throw new Error(`${path.basename(full)} doesn't look like a text file. (For pictures, use /image.)`);
	}

	let text = buffer.toString("utf8")
		.replace(/^﻿/, "")				// Byte order mark, as Windows editors often add.
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/^\n+|\n+$/g, "");

	if (!text) {
		throw new Error(`${path.basename(full)} is empty.`);
	}
	if (text.length > MAX_CHARS) {
		throw new Error(`${path.basename(full)} is too long (${text.length} characters; at most ${MAX_CHARS}).`);
	}

	return {
		name: path.basename(full),
		text,
		lines: text.split("\n").length,
		tokens: Math.ceil(text.length / 4),
	};
}

module.exports = {prepare_text_file, MAX_CHARS};
