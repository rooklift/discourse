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
	storage.versions = Object.create(null);		// Changes this session, per file (see version()).
	storage.seen = Object.create(null);			// Per model: the version of each file it last saw in full.
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
		this.bump(name);
		return {name, size, existed};
	},

	// Adds to the end of a file (creating it if need be), with a line break between the old
	// and new content if there isn't one already.

	append: function(filename, content, author) {
		let name = this.canonical(filename);
		if (!lexists(this.full_path(name))) {
			let r = this.write(name, content, author);
			return {name: r.name, size: r.size, created: true};
		}
		let {full} = this.existing(name);
		let old = read_text(full);
		let joiner = (old.length > 0 && !old.endsWith("\n") && !content.startsWith("\n")) ? "\n" : "";
		let updated = old + joiner + content;
		let size = Buffer.byteLength(updated, "utf8");
		this.check_room(name, size);
		replace_text(full, updated);
		this.stamp(name, author);
		this.bump(name);
		return {name, size, created: false};
	},

	// Plain-text search across the folder (or one file). No regular expressions, so no
	// pattern can be slow. Returns matching lines with line numbers.

	search: function(query, opts = {}) {
		if (typeof query !== "string" || !query) {
			throw new Error("query must be a non-empty string.");
		}
		if (query.length > 200) {
			throw new Error("query is too long (at most 200 characters).");
		}
		let case_sensitive = opts.case_sensitive === true;
		let needle = case_sensitive ? query : query.toLowerCase();
		let names = typeof opts.filename === "string" ? [this.existing(opts.filename).name] : this.files().map(f => f.name);
		let matches = [];
		let truncated = false;
		for (let name of names) {
			let text;
			try {
				text = read_text(this.existing(name).full);
			} catch (error) {
				continue;
			}
			let lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				let hay = case_sensitive ? lines[i] : lines[i].toLowerCase();
				if (hay.includes(needle)) {
					if (matches.length >= 100) {
						truncated = true;
						break;
					}
					let line = lines[i].length > 200 ? lines[i].slice(0, 200) + "..." : lines[i];
					matches.push({name, line_number: i + 1, line});
				}
			}
		}
		return {matches, truncated};
	},

	// Versions count changes made during this session, so the tools can tell whether a model
	// has seen a file as it is now. Keys are lower case, as filenames are case-insensitive.

	version: function(name) {
		return this.versions[name.toLowerCase()] || 0;
	},

	bump: function(name) {
		let key = name.toLowerCase();
		this.versions[key] = (this.versions[key] || 0) + 1;
	},

	mark_seen: function(actor, name) {
		if (!this.seen[actor]) {
			this.seen[actor] = Object.create(null);
		}
		this.seen[actor][name.toLowerCase()] = this.version(name);
	},

	has_seen_current: function(actor, name) {
		let mine = this.seen[actor];
		let key = name.toLowerCase();
		return Boolean(mine) && Object.hasOwn(mine, key) && mine[key] === this.version(name);
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
		this.bump(name);
		return {name, size};
	},

	delete: function(filename) {
		let {name, full} = this.existing(filename);
		fs.unlinkSync(full);
		this.forget(name);
		this.bump(name);
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

const FILE_TOOL_NAMES = ["list_files", "read_file", "search_files", "write_file", "append_file", "edit_file", "delete_file"];

// The tool definitions, with a "folder" choice on each when the room has a shared folder.

function make_file_tools(has_shared) {

	let where = has_shared ? "your private folder, or the shared folder" : "your private folder";
	let filename = {type: "string", description: "Just the filename, e.g. notes.md. No folders."};

	let tools = [
		{
			name: "list_files",
			description: `List the files in ${where}, with sizes, dates, and who last wrote each one.`,
			props: {},
			required: [],
		},
		{
			name: "read_file",
			description: `Read one file from ${where}.`,
			props: {filename},
			required: ["filename"],
		},
		{
			name: "search_files",
			description: `Search the files in ${where} for a piece of text (plain text, not a pattern; case-insensitive unless asked). Returns matching lines with filenames and line numbers.`,
			props: {
				query: {type: "string", description: "The text to look for."},
				filename: {type: "string", description: "Optional: search just this file."},
				case_sensitive: {type: "boolean", description: "Optional: match upper and lower case exactly. Default false."},
			},
			required: ["query"],
		},
		{
			name: "write_file",
			description: `Create a file in ${where}, or replace one completely. To replace a file that already exists, you must have read it in this session (and${has_shared ? ", in the shared folder," : ""} it mustn't have changed since), or set overwrite to true. To add to a file, use append_file; for small changes, edit_file.`,
			props: {
				filename,
				content: {type: "string", description: "The whole new content of the file."},
				overwrite: {type: "boolean", description: "Optional: replace an existing file even if you haven't read it as it is now."},
			},
			required: ["filename", "content"],
		},
		{
			name: "append_file",
			description: `Add text to the end of a file in ${where}, creating the file if it doesn't exist. A line break is added between the old and new text if needed.`,
			props: {
				filename,
				content: {type: "string", description: "The text to add."},
			},
			required: ["filename", "content"],
		},
		{
			name: "edit_file",
			description: `Change part of a file in ${where} by replacing one exact passage. old_text must appear exactly once in the file.`,
			props: {
				filename,
				old_text: {type: "string", description: "The exact text to replace, appearing once in the file."},
				new_text: {type: "string", description: "What to replace it with. Can be empty, to delete the passage."},
			},
			required: ["filename", "old_text", "new_text"],
		},
		{
			name: "delete_file",
			description: `Delete a file from ${where}. This can't be undone.`,
			props: {filename},
			required: ["filename"],
		},
	];

	return tools.map(t => {
		let properties = Object.assign({}, t.props);
		if (has_shared) {
			properties.folder = {
				type: "string",
				enum: ["private", "shared"],
				description: "Optional: \"private\" (your own folder, the default) or \"shared\" (one folder that every model in the room can read and write).",
			};
		}
		let tool = {name: t.name, description: t.description, input_schema: {type: "object", properties, required: t.required}};
		return t.required.length ? make_strict(tool) : tool;
	});
}

// Strict tool use makes the API guarantee that a call includes every required field, with the
// right types (a model once called append_file with no filename at all). Strict schemas must
// set additionalProperties to false. Tools with nothing required gain nothing, so stay as they are.

function make_strict(tool) {
	tool.strict = true;
	tool.input_schema.additionalProperties = false;
	return tool;
}

const REQUIRED_FIELDS = {
	read_file: ["filename"],
	search_files: ["query"],
	write_file: ["filename", "content"],
	append_file: ["filename", "content"],
	edit_file: ["filename", "old_text", "new_text"],
	delete_file: ["filename"],
};

const SHARED_VERBS = {write_file: null, append_file: "added to", edit_file: "edited", delete_file: "deleted"};

// Runs one file tool call.
//
//   storages: {private, shared} (shared may be null). A single storage is accepted too.
//   actor:    {key, stamp}: key identifies the model (for read tracking), stamp is what the
//             metadata records as the writer. A plain string is used for both.
//
// Returns {content, is_error, summary, folder, name, announce}. The summary is for the host's
// transcript; announce, set when a shared file changes, is a notice for the other models.

function run_file_tool(storages, tool_use, actor) {

	if (storages && storages.folder) {
		storages = {private: storages, shared: null};
	}
	if (typeof actor === "string") {
		actor = {key: actor, stamp: actor};
	}

	// Anything here may come straight from the model, so check types before using or even
	// printing it: a filename could be an object whose toString throws.

	let input = (tool_use.input && typeof tool_use.input === "object") ? tool_use.input : {};
	let tool_name = typeof tool_use.name === "string" ? tool_use.name : "(unnamed tool)";
	let shown = typeof input.filename === "string" ? JSON.stringify(input.filename.slice(0, 80)) : "";
	let folder = input.folder === undefined ? "private" : input.folder;
	let in_folder = folder === "shared" ? " in the shared folder" : "";

	let done = (content, summary, extra = {}) => Object.assign({content, is_error: false, summary: summary + in_folder, folder}, extra);

	try {

		// Say plainly when a field is missing altogether, and what the call did include, so a
		// model doesn't conclude that a perfectly good filename was rejected.

		let missing = (REQUIRED_FIELDS[tool_name] || []).filter(k => input[k] === undefined || input[k] === null);
		if (missing.length > 0) {
			let given = Object.keys(input).filter(k => input[k] !== undefined && input[k] !== null);
			let example = missing.includes("filename") ? " Say which file, for example \"notes.md\"." : "";
			throw new Error(`The call was missing ${missing.join(" and ")} (it included ${given.length ? given.join(", ") : "nothing"}).${example}`);
		}

		if (folder !== "private" && folder !== "shared") {
			throw new Error("folder must be \"private\" or \"shared\".");
		}
		let storage = storages[folder];
		if (!storage) {
			throw new Error(folder === "shared" ? "There's no shared folder in this room." : "There's no private folder in this room.");
		}

		let announce = (verb, name) => folder === "shared" ? `${actor.key} ${verb} ${name} in the shared folder.` : "";

		switch (tool_name) {

		case "list_files":
			return done(storage.listing(), "listed their files");

		case "read_file": {
			let r = storage.read(input.filename);
			storage.mark_seen(actor.key, r.name);
			return done(r.text.length > 0 ? r.text : "(the file is empty)", `read ${r.name}`, {name: r.name});
		}

		case "search_files": {
			if (input.filename !== undefined && typeof input.filename !== "string") {
				throw new Error("filename must be a string.");
			}
			let r = storage.search(input.query, {filename: input.filename, case_sensitive: input.case_sensitive});
			let lines = r.matches.map(m => `${m.name}:${m.line_number}: ${m.line}`);
			let text = lines.length ? lines.join("\n") : "No matches.";
			if (r.truncated) {
				text += "\n(Stopped at 100 matches.)";
			}
			let q = typeof input.query === "string" ? JSON.stringify(input.query.slice(0, 80)) : "";
			return done(text, `searched for ${q} (${r.matches.length}${r.truncated ? "+" : ""} matches)`);
		}

		case "write_file": {
			if (typeof input.content !== "string") {
				throw new Error("content must be a string.");
			}
			let name = storage.canonical(input.filename);
			if (storage.exists(name) && input.overwrite !== true && !storage.has_seen_current(actor.key, name)) {
				let stale = storage.seen[actor.key] && Object.hasOwn(storage.seen[actor.key], name.toLowerCase());
				throw new Error(stale
					? `${name} has changed since you last read it. Read it again first, or set overwrite to true to replace it anyway.`
					: `${name} already exists and you haven't read it in this session. Read it first, or set overwrite to true to replace it without reading.`);
			}
			let r = storage.write(name, input.content, actor.stamp);
			storage.mark_seen(actor.key, r.name);
			let verb = r.existed ? "rewrote" : "created";
			return done(`${r.existed ? "Replaced" : "Created"} ${r.name} (${r.size} bytes).`, `${verb} ${r.name} (${r.size} bytes)`, {name: r.name, announce: announce(verb, r.name)});
		}

		case "append_file": {
			if (typeof input.content !== "string") {
				throw new Error("content must be a string.");
			}
			let name = storage.canonical(input.filename);
			let was_current = storage.has_seen_current(actor.key, name);
			let r = storage.append(name, input.content, actor.stamp);
			if (r.created || was_current) {
				storage.mark_seen(actor.key, r.name);
			}
			let verb = r.created ? "created" : "added to";
			return done(`${r.created ? "Created" : "Added to"} ${r.name} (now ${r.size} bytes).`, `${verb} ${r.name} (now ${r.size} bytes)`, {name: r.name, announce: announce(verb, r.name)});
		}

		case "edit_file": {
			if (typeof input.old_text !== "string" || typeof input.new_text !== "string") {
				throw new Error("old_text and new_text must be strings.");
			}
			let name = storage.canonical(input.filename);
			let was_current = storage.has_seen_current(actor.key, name);
			let r = storage.edit(name, input.old_text, input.new_text, actor.stamp);
			if (was_current) {
				storage.mark_seen(actor.key, r.name);
			}
			return done(`Edited ${r.name} (now ${r.size} bytes).`, `edited ${r.name}`, {name: r.name, announce: announce(SHARED_VERBS.edit_file, r.name)});
		}

		case "delete_file": {
			let r = storage.delete(input.filename);
			return done(`Deleted ${r.name}.`, `deleted ${r.name}`, {name: r.name, announce: announce(SHARED_VERBS.delete_file, r.name)});
		}
		}
	} catch (error) {
		let message = typeof error?.message === "string" ? error.message : "something went wrong.";
		let where = (folder === "shared") ? " in the shared folder" : "";
		return {content: `Error: ${message}`, is_error: true, summary: `tried ${tool_name}${shown ? ` on ${shown}` : ""}${where}, error: ${message}`, folder: typeof folder === "string" ? folder : "private"};
	}

	return {content: `Unknown tool: ${tool_name}`, is_error: true, summary: `unknown tool ${tool_name}`, folder: "private"};
}

const FILE_TOOLS = make_file_tools(false);

module.exports = {new_storage, make_file_tools, make_strict, FILE_TOOLS, FILE_TOOL_NAMES, run_file_tool, LIMITS};
