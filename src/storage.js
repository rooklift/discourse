"use strict";

// Each model's private folder of text files, kept between sessions.
//
// The only way in is a bare filename, checked against a strict pattern: no slashes, no "..",
// no leading dot, no subfolders. Every resolved path is checked to sit directly inside the
// model's own folder, and symlinks and anything that isn't a regular file are refused.
// Metadata (which model version wrote each file) lives in a hidden file the tools can't name.

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

	// Returns the full path for a filename, or throws with a message meant for the model.

	resolve: function(filename) {
		if (typeof filename !== "string" || !NAME_RE.test(filename)) {
			throw new Error("Invalid filename. Use 1 to 64 characters: letters, digits, '.', '-' or '_', not starting with '.'. No folders.");
		}
		if (filename.endsWith(".") || RESERVED_RE.test(filename)) {
			throw new Error("That filename isn't allowed. Try another.");
		}
		let full = path.resolve(this.folder, filename);
		if (path.dirname(full) !== this.folder) {
			throw new Error("Invalid filename.");
		}
		return full;
	},

	// Like resolve(), but also requires an existing regular file (never a symlink or folder).

	existing: function(filename) {
		let full = this.resolve(filename);
		let st;
		try {
			st = fs.lstatSync(full);
		} catch (error) {
			throw new Error(`No file called ${filename}.`);
		}
		if (!st.isFile() || st.isSymbolicLink()) {
			throw new Error(`${filename} isn't a regular file and can't be used.`);
		}
		return full;
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
		for (let d of fs.readdirSync(this.folder, {withFileTypes: true})) {
			if (d.isFile() && !d.isSymbolicLink() && NAME_RE.test(d.name)) {
				let st = fs.statSync(path.join(this.folder, d.name));
				out.push({name: d.name, size: st.size, modified: st.mtime});
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	},

	read_meta: function() {
		try {
			let full = path.join(this.folder, META_FILE);
			let st = fs.lstatSync(full);
			if (!st.isFile() || st.isSymbolicLink()) {
				return {};
			}
			let o = JSON.parse(fs.readFileSync(full, "utf8"));
			return (o && typeof o === "object") ? o : {};
		} catch (error) {
			return {};
		}
	},

	write_meta: function(meta) {
		let full = path.join(this.folder, META_FILE);
		if (lexists(full) && !fs.lstatSync(full).isFile()) {
			return;								// Never write through a symlink.
		}
		fs.writeFileSync(full, JSON.stringify(meta, null, "\t") + "\n");
	},

	stamp: function(filename, author) {
		let meta = this.read_meta();
		let now = new Date().toISOString();
		let old = meta[filename] || {};
		meta[filename] = {
			created: old.created || now,
			created_by: old.created_by || author,
			modified: now,
			modified_by: author,
		};
		this.write_meta(meta);
	},

	forget: function(filename) {
		let meta = this.read_meta();
		delete meta[filename];
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
			let m = meta[f.name];
			let when = (m?.modified || f.modified.toISOString()).slice(0, 16).replace("T", " ");
			let by = m?.modified_by ? `, last written by ${m.modified_by}` : "";
			return `- ${f.name} (${f.size} bytes, ${when} UTC${by})`;
		});
		lines.push(`${files.length} of ${LIMITS.file_count} files, ${total} of ${LIMITS.total_bytes} bytes used.`);
		return lines.join("\n");
	},

	check_room: function(filename, new_size) {
		if (new_size > LIMITS.file_bytes) {
			throw new Error(`Too big: files can be at most ${LIMITS.file_bytes} bytes (this would be ${new_size}).`);
		}
		let files = this.files();
		let others = files.filter(f => f.name !== filename);
		if (others.length === files.length && files.length >= LIMITS.file_count) {
			throw new Error(`The folder already holds the maximum of ${LIMITS.file_count} files. Delete or reuse one.`);
		}
		let total = others.reduce((n, f) => n + f.size, 0) + new_size;
		if (total > LIMITS.total_bytes) {
			throw new Error(`Not enough space: the folder can hold ${LIMITS.total_bytes} bytes in all, and this would make ${total}.`);
		}
	},

	read: function(filename) {
		return fs.readFileSync(this.existing(filename), "utf8");
	},

	write: function(filename, content, author) {
		let full = this.resolve(filename);
		if (lexists(full)) {
			this.existing(filename);			// Refuses to write through a symlink (even a dangling one) or onto a folder.
		}
		let size = Buffer.byteLength(content, "utf8");
		this.check_room(filename, size);
		fs.writeFileSync(full, content, "utf8");
		this.stamp(filename, author);
		return size;
	},

	edit: function(filename, old_text, new_text, author) {
		let full = this.existing(filename);
		let content = fs.readFileSync(full, "utf8");
		if (!old_text) {
			throw new Error("old_text can't be empty.");
		}
		let count = content.split(old_text).length - 1;
		if (count === 0) {
			throw new Error(`old_text wasn't found in ${filename}. It has to match exactly, including spaces and line breaks.`);
		}
		if (count > 1) {
			throw new Error(`old_text appears ${count} times in ${filename}. Include more of the surrounding text so it matches once.`);
		}
		let i = content.indexOf(old_text);
		let updated = content.slice(0, i) + new_text + content.slice(i + old_text.length);
		let size = Buffer.byteLength(updated, "utf8");
		this.check_room(filename, size);
		fs.writeFileSync(full, updated, "utf8");
		this.stamp(filename, author);
		return size;
	},

	delete: function(filename) {
		fs.unlinkSync(this.existing(filename));
		this.forget(filename);
	},
};

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

	let input = tool_use.input || {};
	let name = input.filename;

	try {
		switch (tool_use.name) {
		case "list_files":
			return {content: storage.listing(), is_error: false, summary: "listed their files"};
		case "read_file": {
			let text = storage.read(name);
			return {content: text.length > 0 ? text : "(the file is empty)", is_error: false, summary: `read ${name}`};
		}
		case "write_file": {
			if (typeof input.content !== "string") {
				throw new Error("content must be a string.");
			}
			let existed = storage.exists(name);
			let size = storage.write(name, input.content, author);
			return {content: `${existed ? "Replaced" : "Created"} ${name} (${size} bytes).`, is_error: false, summary: `${existed ? "rewrote" : "created"} ${name} (${size} bytes)`};
		}
		case "edit_file": {
			if (typeof input.old_text !== "string" || typeof input.new_text !== "string") {
				throw new Error("old_text and new_text must be strings.");
			}
			let size = storage.edit(name, input.old_text, input.new_text, author);
			return {content: `Edited ${name} (now ${size} bytes).`, is_error: false, summary: `edited ${name}`};
		}
		case "delete_file":
			storage.delete(name);
			return {content: `Deleted ${name}.`, is_error: false, summary: `deleted ${name}`};
		}
	} catch (error) {
		return {content: `Error: ${error.message}`, is_error: true, summary: `tried ${tool_use.name}${name ? ` on ${name}` : ""}, error: ${error.message}`};
	}

	return {content: `Unknown tool: ${tool_use.name}`, is_error: true, summary: `unknown tool ${tool_use.name}`};
}

module.exports = {new_storage, FILE_TOOLS, FILE_TOOL_NAMES, run_file_tool, LIMITS};
