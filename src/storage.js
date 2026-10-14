"use strict";

// Each model's private folder of text files, kept between sessions.
//
// The only way in is a bare filename, checked against a strict pattern: no slashes, no "..",
// no leading dot, no subfolders. Every resolved path is checked to sit directly inside the
// model's own folder. Symlinks, hard-linked files and anything that isn't a plain file are
// refused, since a link placed in a folder from outside could lead elsewhere. Names are
// case-insensitive. Metadata (which model version wrote each file) lives in a hidden file the
// tools can't name.

const fs = require("fs");
const path = require("path");

const LIMITS = {
	file_bytes: 100 * 1024,
	total_bytes: 1024 * 1024,
	file_count: 100,
};

const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;		// Windows device names.
const META_FILE = ".meta.json";

// Like fs.existsSync, but doesn't follow symlinks, so a dangling symlink counts as existing.

function lexists(p) {
	try {
		fs.lstatSync(p);
		return true;
	} catch (error) {
		return false;
	}
}

function new_storage(root_dir, name) {

	let folder = path.resolve(root_dir, name);
	fs.mkdirSync(folder, {recursive: true});

	let st = fs.lstatSync(folder);
	if (!st.isDirectory() || st.isSymbolicLink()) {
		throw new Error(`Storage folder for ${name} is not a plain directory: ${folder}`);
	}

	let storage = Object.create(storage_prototype);
	storage.folder = folder;
	return storage;
}

const storage_prototype = {

	// Checks a filename the model gave us. Throws with a message meant for the model.

	validate: function(filename) {
		if (typeof filename !== "string" || !NAME_RE.test(filename)) {
			throw new Error("Invalid filename. Use 1 to 64 characters: letters, digits, '.', '-' or '_', not starting with '.'. No folders.");
		}
		if (filename.endsWith(".") || RESERVED_RE.test(filename)) {
			throw new Error("That filename isn't allowed. Try another.");
		}
		return filename;
	},

	// Filenames are case-insensitive here, as they are on Windows and macOS: "Notes.md" and
	// "notes.md" are the same file everywhere, so quotas and metadata can't split between
	// two spellings. Returns the spelling of the existing file if there is one.

	canonical: function(filename) {
		this.validate(filename);
		let names = fs.readdirSync(this.folder);
		if (names.includes(filename)) {
			return filename;
		}
		let lower = filename.toLowerCase();
		return names.find(n => n.toLowerCase() === lower) || filename;
	},

	full_path: function(name) {
		let full = path.resolve(this.folder, name);
		if (path.dirname(full) !== this.folder) {
			throw new Error("Invalid filename.");
		}
		return full;
	},

	// The canonical name and full path of an existing, plain file. Refuses symlinks (even
	// dangling ones), folders, and files with other hard links, which could lead outside.

	existing: function(filename) {
		let name = this.canonical(filename);
		let full = this.full_path(name);
		let st;
		try {
			st = fs.lstatSync(full);
		} catch (error) {
			throw new Error(`No file called ${name}.`);
		}
		if (!usable(st)) {
			throw new Error(`${name} isn't a plain file and can't be used.`);
		}
		return {name, full};
	},

	exists: function(filename) {
		try {
			this.existing(filename);
			return true;
		} catch (error) {
			return false;
		}
	},

	files: function() {
		let out = [];
		for (let name of fs.readdirSync(this.folder)) {
			if (!NAME_RE.test(name)) {
				continue;
			}
			let st = fs.lstatSync(path.join(this.folder, name));
			if (usable(st)) {
				out.push({name, size: st.size, modified: st.mtime});
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	},

	// Metadata is a dictionary with no prototype, so a file called __proto__ is just a key.

	read_meta: function() {
		let meta = Object.create(null);
		try {
			let full = path.join(this.folder, META_FILE);
			if (!usable(fs.lstatSync(full))) {
				return meta;
			}
			let o = JSON.parse(fs.readFileSync(full, "utf8"));
			if (o && typeof o === "object" && !Array.isArray(o)) {
				for (let key of Object.keys(o)) {
					if (o[key] && typeof o[key] === "object") {
						meta[key] = o[key];
					}
				}
			}
		} catch (error) {
			// Missing or unreadable: start afresh.
		}
		return meta;
	},

	write_meta: function(meta) {
		let full = path.join(this.folder, META_FILE);
		if (lexists(full) && !usable(fs.lstatSync(full))) {
			return;								// Never write through a link.
		}
		fs.writeFileSync(full, JSON.stringify(meta, null, "\t") + "\n");
	},

	stamp: function(name, author) {
		let meta = this.read_meta();
		let now = new Date().toISOString();
		let old = meta[name] || {};
		meta[name] = {
			created: old.created || now,
			created_by: old.created_by || author,
			modified: now,
			modified_by: author,
		};
		this.write_meta(meta);
	},

	forget: function(name) {
		let meta = this.read_meta();
		delete meta[name];
		this.write_meta(meta);
	},

	// A human- and model-readable listing, including who last wrote each file.

	listing: function() {
		let files = this.files();
		if (files.length === 0) {
			return "(empty)";
		}
		let meta = this.read_meta();
		let total = files.reduce((n, f) => n + f.size, 0);
		let lines = files.map(f => {
			let m = meta[f.name] || null;
			let modified = typeof m?.modified === "string" ? m.modified : f.modified.toISOString();
			let when = modified.slice(0, 16).replace("T", " ");
			let by = typeof m?.modified_by === "string" ? `, last written by ${m.modified_by}` : "";
			return `- ${f.name} (${f.size} bytes, ${when} UTC${by})`;
		});
		lines.push(`${files.length} of ${LIMITS.file_count} files, ${total} of ${LIMITS.total_bytes} bytes used.`);
		return lines.join("\n");
	},

	check_room: function(name, new_size) {
		if (new_size > LIMITS.file_bytes) {
			throw new Error(`Too big: files can be at most ${LIMITS.file_bytes} bytes (this would be ${new_size}).`);
		}
		let files = this.files();
		let others = files.filter(f => f.name.toLowerCase() !== name.toLowerCase());
		if (others.length === files.length && files.length >= LIMITS.file_count) {
			throw new Error(`The folder already holds the maximum of ${LIMITS.file_count} files. Delete or reuse one.`);
		}
		let total = others.reduce((n, f) => n + f.size, 0) + new_size;
		if (total > LIMITS.total_bytes) {
			throw new Error(`Not enough space: the folder can hold ${LIMITS.total_bytes} bytes in all, and this would make ${total}.`);
		}
	},

	// Each of these returns the canonical name it acted on, so results can report it.

	read: function(filename) {
		let {name, full} = this.existing(filename);
		return {name, text: fs.readFileSync(full, "utf8")};
	},

	write: function(filename, content, author) {
		let name = this.canonical(filename);
		let full = this.full_path(name);
		let existed = lexists(full);
		if (existed) {
			this.existing(name);				// Refuses to write through a link or onto a folder.
		}
		let size = Buffer.byteLength(content, "utf8");
		this.check_room(name, size);
		fs.writeFileSync(full, content, "utf8");
		this.stamp(name, author);
		return {name, size, existed};
	},

	edit: function(filename, old_text, new_text, author) {
		let {name, full} = this.existing(filename);
		if (!old_text) {
			throw new Error("old_text can't be empty.");
		}
		let content = fs.readFileSync(full, "utf8");
		let first = content.indexOf(old_text);
		if (first === -1) {
			throw new Error(`old_text wasn't found in ${name}. It has to match exactly, including spaces and line breaks.`);
		}
		if (content.indexOf(old_text, first + 1) !== -1) {		// Overlapping matches count too ("aa" in "aaa").
			throw new Error(`old_text matches more than one place in ${name}. Include more of the surrounding text so it matches once.`);
		}
		let updated = content.slice(0, first) + new_text + content.slice(first + old_text.length);
		let size = Buffer.byteLength(updated, "utf8");
		this.check_room(name, size);
		fs.writeFileSync(full, updated, "utf8");
		this.stamp(name, author);
		return {name, size};
	},

	delete: function(filename) {
		let {name, full} = this.existing(filename);
		fs.unlinkSync(full);
		this.forget(name);
		return {name};
	},
};

// A plain file we can safely use: not a symlink or folder, and with no other hard links.

function usable(st) {
	return st.isFile() && !st.isSymbolicLink() && st.nlink === 1;
}

// ------------------------------------------------------------------------------------------------
// Tool definitions and dispatch, used by the room.

const FILE_TOOLS = [
	{
		name: "list_files",
		description: "List the files in your private folder, with sizes, dates, and which model version last wrote each one.",
		input_schema: {type: "object", properties: {}},
	},
	{
		name: "read_file",
		description: "Read one file from your private folder.",
		input_schema: {
			type: "object",
			properties: {filename: {type: "string", description: "Just the filename, e.g. notes.md. No folders."}},
			required: ["filename"],
		},
	},
	{
		name: "write_file",
		description: "Create a file in your private folder, or replace one completely. For small changes to an existing file, edit_file is better.",
		input_schema: {
			type: "object",
			properties: {
				filename: {type: "string", description: "Just the filename, e.g. notes.md. No folders."},
				content: {type: "string", description: "The whole new content of the file."},
			},
			required: ["filename", "content"],
		},
	},
	{
		name: "edit_file",
		description: "Change part of a file in your private folder by replacing one exact passage. old_text must appear exactly once in the file.",
		input_schema: {
			type: "object",
			properties: {
				filename: {type: "string", description: "Just the filename. No folders."},
				old_text: {type: "string", description: "The exact text to replace, appearing once in the file."},
				new_text: {type: "string", description: "What to replace it with. Can be empty, to delete the passage."},
			},
			required: ["filename", "old_text", "new_text"],
		},
	},
	{
		name: "delete_file",
		description: "Delete a file from your private folder. This can't be undone.",
		input_schema: {
			type: "object",
			properties: {filename: {type: "string", description: "Just the filename. No folders."}},
			required: ["filename"],
		},
	},
];

const FILE_TOOL_NAMES = FILE_TOOLS.map(t => t.name);

// Runs one file tool call. Returns {content, is_error, summary}; the summary is a short
// description for the host's transcript.

function run_file_tool(storage, tool_use, author) {

	// Anything here may come straight from the model, so check types before using or even
	// printing it: a filename could be an object whose toString throws.

	let input = (tool_use.input && typeof tool_use.input === "object") ? tool_use.input : {};
	let tool_name = typeof tool_use.name === "string" ? tool_use.name : "(unnamed tool)";
	let shown = typeof input.filename === "string" ? JSON.stringify(input.filename.slice(0, 80)) : "";

	try {
		switch (tool_name) {
		case "list_files":
			return {content: storage.listing(), is_error: false, summary: "listed their files"};
		case "read_file": {
			let r = storage.read(input.filename);
			return {content: r.text.length > 0 ? r.text : "(the file is empty)", is_error: false, summary: `read ${r.name}`};
		}
		case "write_file": {
			if (typeof input.content !== "string") {
				throw new Error("content must be a string.");
			}
			let r = storage.write(input.filename, input.content, author);
			return {
				content: `${r.existed ? "Replaced" : "Created"} ${r.name} (${r.size} bytes).`,
				is_error: false,
				summary: `${r.existed ? "rewrote" : "created"} ${r.name} (${r.size} bytes)`,
			};
		}
		case "edit_file": {
			if (typeof input.old_text !== "string" || typeof input.new_text !== "string") {
				throw new Error("old_text and new_text must be strings.");
			}
			let r = storage.edit(input.filename, input.old_text, input.new_text, author);
			return {content: `Edited ${r.name} (now ${r.size} bytes).`, is_error: false, summary: `edited ${r.name}`};
		}
		case "delete_file": {
			let r = storage.delete(input.filename);
			return {content: `Deleted ${r.name}.`, is_error: false, summary: `deleted ${r.name}`};
		}
		}
	} catch (error) {
		let message = typeof error?.message === "string" ? error.message : "something went wrong.";
		return {content: `Error: ${message}`, is_error: true, summary: `tried ${tool_name}${shown ? ` on ${shown}` : ""}, error: ${message}`};
	}

	return {content: `Unknown tool: ${tool_name}`, is_error: true, summary: `unknown tool ${tool_name}`};
}

module.exports = {new_storage, FILE_TOOLS, FILE_TOOL_NAMES, run_file_tool, LIMITS};
