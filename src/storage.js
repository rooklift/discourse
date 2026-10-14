"use strict";

// Each model's private folder of text files, kept between sessions.
//
// The only way in is a bare filename, checked against a strict pattern: no slashes, no "..",
// no leading dot, no subfolders. Every resolved path is checked to sit directly inside the
// model's own folder. Symlinks, hard-linked files and anything that isn't a plain file are
// refused, since a link placed in a folder from outside could lead elsewhere. Names are
// case-insensitive. Metadata (which model version wrote each file) lives in a hidden file the
// tools can't name.

const crypto = require("crypto");
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
	storage.real = fs.realpathSync(folder);		// Where the folder really is; rechecked on every use.
	remove_stale_temps(folder);
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

	// The folder must still be the same real directory it was at startup. If something has
	// replaced it, or anything above it, with a link or junction, refuse to touch it.

	guard: function() {
		let ok = false;
		try {
			let st = fs.lstatSync(this.folder);
			ok = st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(this.folder) === this.real;
		} catch (error) {
			ok = false;
		}
		if (!ok) {
			throw new Error("Your folder isn't available right now.");
		}
	},

	canonical: function(filename) {
		this.validate(filename);
		this.guard();
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
		this.guard();
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
			let o = JSON.parse(read_text(full));
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
		let text = JSON.stringify(meta, null, "\t") + "\n";
		try {
			if (lexists(full)) {
				replace_text(full, text);
			} else {
				create_text(full, text);
			}
		} catch (error) {
			// Metadata is a convenience; never let it break a file operation.
		}
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
		return {name, text: read_text(full)};
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
		if (existed) {
			replace_text(full, content);
		} else {
			create_text(full, content);
		}
		this.stamp(name, author);
		return {name, size, existed};
	},

	edit: function(filename, old_text, new_text, author) {
		let {name, full} = this.existing(filename);
		if (!old_text) {
			throw new Error("old_text can't be empty.");
		}
		let content = read_text(full);
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
		replace_text(full, updated);
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

// All file I/O goes through handles that are checked after opening, so a file swapped for a
// link between our check and the open is still refused. O_NOFOLLOW refuses a symlink at the
// moment of opening where the platform supports it (not Windows, where the checks still apply).
// New files are created exclusively, which never follows an existing link.
//
// Writes never put existing data at risk: a replacement is written in full to a temporary
// file beside the original, synced to disk, and only then renamed over it, so a full disk or
// any other failure leaves the original as it was. Renaming replaces the directory entry
// itself, so it can't write through a link either.
//
// What this can't stop: Node has no way to open a file relative to a held folder handle, so a
// local process racing to swap the folder itself between our check and the open could still
// redirect one operation. Against a hostile local user, use file permissions.

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const TEMP_PREFIX = ".tmp-";					// Hidden, so the tools can never name or list them.

function open_checked(full, flags) {
	let fd = fs.openSync(full, flags | NOFOLLOW);
	try {
		if (!usable(fs.fstatSync(fd))) {
			throw new Error(`${path.basename(full)} isn't a plain file and can't be used.`);
		}
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

function read_text(full) {
	let fd = open_checked(full, fs.constants.O_RDONLY);
	try {
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

// writeSync may write fewer bytes than asked; keep going until all of them are written.

function write_all(fd, text) {
	let buf = Buffer.from(text, "utf8");
	let done = 0;
	while (done < buf.length) {
		let n = fs.writeSync(fd, buf, done, buf.length - done, done);
		if (!(n > 0)) {
			throw new Error("The disk accepted no more data.");
		}
		done += n;
	}
}

// Creates a new file exclusively, writes it in full and syncs it. If anything fails, the
// partly written file is removed. With "like" (another file's stats), the file is created
// owner-only, written, and only then given that file's owner and exact mode, so its content
// is never more exposed than the original's.

function create_text(full, text, like = null) {
	let fd;
	try {
		fd = fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, like === null ? 0o666 : 0o600);
	} catch (error) {
		if (error.code === "EEXIST") {
			throw new Error(`${path.basename(full)} appeared while being created. Try again.`);
		}
		throw error;
	}
	try {
		write_all(fd, text);
		fs.fsyncSync(fd);
		if (like !== null) {
			if (process.platform !== "win32" && (like.uid !== process.getuid() || like.gid !== process.getgid())) {
				try {
					fs.fchownSync(fd, like.uid, like.gid);		// Only possible with the right privileges.
				} catch (error) {
					// Not permitted: the replacement stays ours, as any rewrite by us would.
				}
			}
			fs.fchmodSync(fd, like.mode & 0o777);
		}
	} catch (error) {
		close_quietly(fd);
		unlink_quietly(full);
		throw error;
	}
	fs.closeSync(fd);
}

// Replaces an existing file's content without ever leaving it truncated or half written,
// keeping its permission bits and (where we're allowed) its owner. The temporary file's name
// carries our process ID, so another session starting up can tell it's in use.
//
// Not kept: Windows ACLs and extended attributes, which Node can't read or copy. A replaced
// file gets the folder's inherited ACL, so set restrictions on the storage folder rather than
// on individual files.

function replace_text(full, text) {
	let fd = open_checked(full, fs.constants.O_RDONLY);		// It must still be a plain file.
	let like;
	try {
		like = fs.fstatSync(fd);
	} finally {
		close_quietly(fd);
	}
	let temp = path.join(path.dirname(full), `${TEMP_PREFIX}${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
	create_text(temp, text, like);
	try {
		fs.renameSync(temp, full);
	} catch (error) {
		unlink_quietly(temp);
		throw error;
	}
}

function close_quietly(fd) {
	try {
		fs.closeSync(fd);
	} catch (error) {
		// Nothing more to do.
	}
}

function unlink_quietly(full) {
	try {
		fs.unlinkSync(full);
	} catch (error) {
		// Nothing more to do.
	}
}

// Temporary files left by a crash mid-write are cleared when the folder is opened. Another
// session may share the folder and be mid-write right now, so a temp file is only removed if
// the process that made it has exited, or if it's over an hour old (a real write takes
// milliseconds). Names without a recognisable process ID go by age alone.

const STALE_TEMP_MS = 60 * 60 * 1000;

function process_running(pid) {
	try {
		process.kill(pid, 0);						// Signal 0 only checks that the process exists.
		return true;
	} catch (error) {
		return error.code === "EPERM";				// Exists, but belongs to someone else.
	}
}

function remove_stale_temps(folder) {
	for (let name of fs.readdirSync(folder)) {
		if (!name.startsWith(TEMP_PREFIX)) {
			continue;
		}
		let full = path.join(folder, name);
		let st;
		try {
			st = fs.lstatSync(full);
		} catch (error) {
			continue;								// Gone already: renamed or cleaned by its owner.
		}
		if (!st.isFile()) {
			continue;
		}
		let match = /^\.tmp-(\d+)-/.exec(name);
		let pid = match ? Number(match[1]) : null;
		let old = Date.now() - st.mtimeMs > STALE_TEMP_MS;
		let orphaned = pid !== null && pid !== process.pid && !process_running(pid);
		if (old || orphaned) {
			unlink_quietly(full);
		}
	}
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
