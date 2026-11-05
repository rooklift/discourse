"use strict";

// The library: a read-only folder of things the host has collected from outside the room (texts
// and images), with an index giving each a one-line description. The models can browse the
// catalogue privately (list_library) and open an item for everyone (open_library_item).
//
// index.txt, in the library folder, has one line per item:
//
//     before_the_law.txt: Franz Kafka, "Before the Law" (1915), a one-page parable.
//
// Lines starting with # are comments. Only files listed in the index are offered, so the folder
// can hold other things too (notes, sources, items not ready yet).

const fs = require("fs");
const path = require("path");
const {prepare_image} = require("./images");
const {prepare_text_file, MAX_CHARS} = require("./textfile");

const INDEX_FILE = "index.txt";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const MAX_DESCRIPTION = 300;

const LIBRARY_TOOLS = [
	{
		name: "list_library",
		description: "Show the library's catalogue: everything in it, with a line about each item and how long it is. Only you see the catalogue; looking costs nothing and commits you to nothing.",
		input_schema: {type: "object", properties: {}},
	},
	{
		name: "open_library_item",
		description: "Open an item from the library and show it to the room. The others see it after your message. A text is also in this tool's result, so you can read it straight away; an image is shown to everyone after your message, you included. An item stays in everyone's view for the rest of the session, so the room allows only a few openings a session (room_status says how many are left), and an item that's already been opened can't be opened again: it's still there, above.",
		input_schema: {
			type: "object",
			properties: {filename: {type: "string", description: "The item's filename, as the catalogue gives it."}},
			required: ["filename"],
			additionalProperties: false,
		},
		strict: true,
	},
];
const LIBRARY_TOOL_NAMES = LIBRARY_TOOLS.map(t => t.name);

// Reads the index and checks every file it lists. Returns {dir, items, problems}: items are
// {name, description, kind ("text" or "image"), full, text?, tokens?}, in index order; problems
// are messages for the host about lines that were skipped.

function load_library(dir) {

	let problems = [];
	let items = [];
	let real_dir;
	try {
		real_dir = fs.realpathSync(dir);
	} catch (error) {
		return {dir, items, problems: [`The library folder ${dir} doesn't exist.`]};
	}

	let index;
	try {
		index = fs.readFileSync(path.join(real_dir, INDEX_FILE), "utf8");
	} catch (error) {
		return {dir, items, problems: [`The library folder has no ${INDEX_FILE}, so it's empty.`]};
	}

	let seen = new Set();
	let lines = index.replace(/^﻿/, "").split(/\r?\n/);

	lines.forEach((line, i) => {
		let where = `${INDEX_FILE} line ${i + 1}`;
		line = line.trim();
		if (!line || line.startsWith("#")) {
			return;
		}
		let colon = line.indexOf(":");
		if (colon === -1) {
			problems.push(`${where}: expected "filename: description".`);
			return;
		}
		let name = line.slice(0, colon).trim();
		let description = line.slice(colon + 1).trim();
		if (!NAME_RE.test(name) || name === INDEX_FILE) {
			problems.push(`${where}: "${name}" isn't a usable filename (letters, digits, '.', '-' and '_', no spaces or folders).`);
			return;
		}
		if (!description) {
			problems.push(`${where}: ${name} has no description.`);
			return;
		}
		if (description.length > MAX_DESCRIPTION) {
			problems.push(`${where}: ${name}'s description is ${description.length} characters; at most ${MAX_DESCRIPTION}.`);
			return;
		}
		if (seen.has(name.toLowerCase())) {
			problems.push(`${where}: ${name} is listed twice; only the first is used.`);
			return;
		}

		// A plain file directly in the folder: no links out of it, no subfolders.

		let full = path.join(real_dir, name);
		let st;
		try {
			st = fs.lstatSync(full);
		} catch (error) {
			problems.push(`${where}: there's no file called ${name}.`);
			return;
		}
		if (!st.isFile() || st.nlink > 1) {
			problems.push(`${where}: ${name} isn't a plain file (links aren't allowed).`);
			return;
		}

		let item = {name, description, kind: IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase()) ? "image" : "text", full};
		if (item.kind === "text") {
			try {
				let t = prepare_text_file(full);
				Object.assign(item, {text: t.text, tokens: t.tokens});
			} catch (error) {
				problems.push(`${where}: ${String(error.message).replace(full, name)}`);
				return;
			}
		}
		seen.add(name.toLowerCase());
		items.push(item);
	});

	return {dir, items, problems};
}

function find_item(library, filename) {
	let lower = String(filename).toLowerCase();
	return library.items.find(it => it.name.toLowerCase() === lower) || null;
}

// The catalogue a model sees. opened: Map of lowercase name -> who opened it.

function catalogue(library, opened) {
	let lines = library.items.map(it => {
		let size = it.kind === "image" ? "image" : `text, about ${words(it.text)}`;
		let who = opened.get(it.name.toLowerCase());
		return `- ${it.name} (${size}${who ? `; opened by ${who} this session` : ""}): ${it.description}`;
	});
	return lines.join("\n");
}

function words(text) {
	let n = text.split(/\s+/).filter(Boolean).length;
	let rounded = n < 100 ? n : (n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100);
	return `${rounded.toLocaleString("en-US")} word${rounded === 1 ? "" : "s"}`;
}

// An item ready to show: a text as it is, an image prepared as the host's are.

async function prepare_item(item) {
	if (item.kind === "text") {
		return {name: item.name, description: item.description, kind: "text", text: item.text, tokens: item.tokens};
	}
	let image = await prepare_image(item.full);
	return Object.assign(image, {name: item.name, description: item.description, kind: "image", source: item.name});
}

module.exports = {load_library, find_item, catalogue, prepare_item, LIBRARY_TOOLS, LIBRARY_TOOL_NAMES, INDEX_FILE, MAX_CHARS};
