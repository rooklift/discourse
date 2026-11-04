"use strict";

// render_svg: draws an SVG file from a model's folder (or the shared one) as an image, which the
// room posts after that model's message, for everyone to see, the model included.
//
// The SVG is rendered from memory, never from a path, so the renderer has no base location to
// resolve links against: it can't pull in other files from the host's disk, or anything from the
// network. Only data: URIs inside the SVG itself are drawn. External entities and XInclude are
// refused by the XML parser.

const sharp = require("sharp");

const RENDER_LONG_EDGE = 1024;				// Every drawing is scaled so its longer side is this.
const MAX_PNG_BYTES = 1024 * 1024;			// Bigger than this (a busy drawing), and it's sent as JPEG.
const RENDER_SECONDS = 10;

function make_render_tool(has_shared, max_renders) {
	let properties = {
		filename: {type: "string", description: "The SVG file to draw, e.g. map.svg."},
	};
	if (has_shared) {
		properties.folder = {
			type: "string",
			enum: ["private", "shared"],
			description: "Optional: \"private\" (your own folder, the default) or \"shared\".",
		};
	}
	return {
		name: "render_svg",
		description: `Draw an SVG file from your folder${has_shared ? " or the shared folder" : ""} as an image and show it to the room: a diagram, map, sketch, chart, or anything else you can draw in SVG. Write the file first with write_file; to change the drawing, edit the file and render it again. The image is posted after your message, as a numbered image like the host's, and everyone sees it then, you included; you won't see it during this turn. Each render is a snapshot: later edits to the file don't change it. It's drawn with its longer side ${RENDER_LONG_EDGE} pixels, on white unless the SVG sets a background. Only what's in the file is drawn: links to other files or to the web aren't followed, though data: URIs work. Images are resent to everyone on every turn, so the room allows ${max_renders} renders a session; room_status says how many are left.`,
		input_schema: {type: "object", properties, required: ["filename"], additionalProperties: false},
		strict: true,
	};
}

// Returns {media_type, data (base64), width, height, tokens}. Throws with a message meant for the
// model.

async function render_svg(text) {

	if (typeof text !== "string" || !text.trim()) {
		throw new Error("the file is empty.");
	}
	let input = Buffer.from(text, "utf8");

	// Its own size, at 72 dpi, decides the scale. Read without the pixel limit, since a drawing
	// may declare any size; the render itself is always about RENDER_LONG_EDGE.

	let meta;
	try {
		meta = await sharp(input, {limitInputPixels: false}).metadata();
	} catch (error) {
		throw new Error(`it couldn't be read as SVG (${first_line(error)}).`);
	}
	if (meta.format !== "svg") {
		throw new Error("it isn't an SVG file.");
	}
	if (!(meta.width > 0 && meta.height > 0)) {
		throw new Error("the drawing has no size. Give the <svg> a width and height, or a viewBox.");
	}

	let density = Math.min(100000, Math.max(1, 72 * RENDER_LONG_EDGE / Math.max(meta.width, meta.height)));
	let scale = RENDER_LONG_EDGE / Math.max(meta.width, meta.height);
	let width = Math.max(1, Math.round(meta.width * scale));
	let height = Math.max(1, Math.round(meta.height * scale));

	let image = () => sharp(input, {density})
		.resize(width, height, {fit: "fill"})				// In case the density had to be clamped.
		.flatten({background: "#ffffff"})
		.timeout({seconds: RENDER_SECONDS});

	let buffer;
	let media_type = "image/png";
	try {
		buffer = await image().png({compressionLevel: 9}).toBuffer();
		if (buffer.length > MAX_PNG_BYTES) {
			buffer = await image().jpeg({quality: 85, mozjpeg: true}).toBuffer();
			media_type = "image/jpeg";
		}
	} catch (error) {
		throw new Error(`it couldn't be drawn (${first_line(error)}).`);
	}

	return {
		media_type,
		data: buffer.toString("base64"),
		width,
		height,
		tokens: Math.ceil(width / 28) * Math.ceil(height / 28),
	};
}

function first_line(error) {
	let message = typeof error?.message === "string" ? error.message : String(error);
	return message.split("\n")[0].replace(/^Input buffer has corrupt header: (glib: )?/, "").slice(0, 300);
}

module.exports = {make_render_tool, render_svg, RENDER_LONG_EDGE};
