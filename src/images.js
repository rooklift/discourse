"use strict";

// Prepares an image the host wants to share: read it, downscale it, and re-encode it, so each
// request stays small (the bytes are resent on every turn; caching saves money, not upload size).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MAX_PIXELS = 1200000;				// About 1.2 megapixels: roughly 1,500 tokens per image.
const MAX_LONG_EDGE = 1568;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

// Returns {media_type, data (base64), width, height, tokens, source}.

async function prepare_image(filepath) {

	if (typeof filepath !== "string" || !filepath.trim()) {
		throw new Error("No image file given.");
	}
	let full = path.resolve(filepath);
	let st;
	try {
		st = fs.statSync(full);
	} catch (error) {
		throw new Error(`Image not found: ${full}`);
	}
	if (!st.isFile()) {
		throw new Error(`Not a file: ${full}`);
	}
	if (st.size > MAX_INPUT_BYTES) {
		throw new Error(`Image is too large (${Math.round(st.size / 1024 / 1024)} MB; at most 50 MB).`);
	}

	let image = sharp(full, {animated: false, limitInputPixels: 268402689}).rotate();		// rotate() applies EXIF orientation.
	let meta;
	try {
		meta = await image.metadata();
	} catch (error) {
		throw new Error(`Couldn't read ${path.basename(full)} as an image.`);
	}

	// EXIF orientations 5 to 8 swap width and height.

	let [w, h] = (meta.orientation >= 5) ? [meta.height, meta.width] : [meta.width, meta.height];
	let scale = Math.min(1, MAX_LONG_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
	let width = Math.max(1, Math.round(w * scale));
	let height = Math.max(1, Math.round(h * scale));

	image = image.resize(width, height, {fit: "fill"});

	// Keep transparency as PNG; everything else becomes JPEG.

	let buffer;
	let media_type;
	if (meta.hasAlpha) {
		buffer = await image.png({compressionLevel: 9}).toBuffer();
		media_type = "image/png";
	} else {
		buffer = await image.jpeg({quality: 85, mozjpeg: true}).toBuffer();
		media_type = "image/jpeg";
	}

	return {
		media_type,
		data: buffer.toString("base64"),
		width,
		height,
		tokens: Math.ceil(width / 28) * Math.ceil(height / 28),
		source: path.basename(full),
	};
}

module.exports = {prepare_image, MAX_PIXELS, MAX_LONG_EDGE};
