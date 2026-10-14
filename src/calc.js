"use strict";

// A small calculator for the models: a hand-written parser over plain numbers, so nothing a
// model types is ever run as code. Doubles throughout (about 15-16 significant digits).
//
// Grammar, loosest binding first:
//   expr    = term (("+" | "-") term)*
//   term    = unary (("*" | "/" | "%") unary)*
//   unary   = ("-" | "+") unary | power
//   power   = postfix ("^" unary)?				right-associative; -2^2 is -(2^2)
//   postfix = primary "!"*
//   primary = number | name | name "(" args ")" | "(" expr ")"

const MAX_LENGTH = 500;
const MAX_DEPTH = 100;

const CONSTANTS = {
	pi: Math.PI,
	e: Math.E,
	tau: 2 * Math.PI,
	phi: (1 + Math.sqrt(5)) / 2,
};

function need_integer(name, ...xs) {
	for (let x of xs) {
		if (!Number.isInteger(x)) {
			throw new Error(`${name} needs whole numbers.`);
		}
	}
}

function factorial(n) {
	need_integer("factorial", n);
	if (n < 0 || n > 170) {
		throw new Error("factorial needs a whole number from 0 to 170.");
	}
	let r = 1;
	for (let i = 2; i <= n; i++) {
		r *= i;
	}
	return r;
}

function comb(n, k) {
	need_integer("comb", n, k);
	if (k < 0 || n < 0 || k > n) {
		return 0;
	}
	k = Math.min(k, n - k);
	let r = 1;
	for (let i = 1; i <= k; i++) {
		r = r * (n - k + i) / i;
	}
	return Math.round(r);
}

function perm(n, k) {
	need_integer("perm", n, k);
	if (k < 0 || n < 0 || k > n) {
		return 0;
	}
	let r = 1;
	for (let i = 0; i < k; i++) {
		r *= n - i;
	}
	return r;
}

function gcd(a, b) {
	need_integer("gcd", a, b);
	a = Math.abs(a);
	b = Math.abs(b);
	while (b) {
		[a, b] = [b, a % b];
	}
	return a;
}

// name: [min args, max args, function]

const FUNCTIONS = {
	sqrt: [1, 1, Math.sqrt],
	cbrt: [1, 1, Math.cbrt],
	abs: [1, 1, Math.abs],
	floor: [1, 1, Math.floor],
	ceil: [1, 1, Math.ceil],
	round: [1, 1, Math.round],
	trunc: [1, 1, Math.trunc],
	sign: [1, 1, Math.sign],
	exp: [1, 1, Math.exp],
	ln: [1, 1, Math.log],
	log10: [1, 1, Math.log10],
	log2: [1, 1, Math.log2],
	log: [1, 2, (x, b) => b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)],
	sin: [1, 1, Math.sin],
	cos: [1, 1, Math.cos],
	tan: [1, 1, Math.tan],
	asin: [1, 1, Math.asin],
	acos: [1, 1, Math.acos],
	atan: [1, 1, Math.atan],
	atan2: [2, 2, Math.atan2],
	sinh: [1, 1, Math.sinh],
	cosh: [1, 1, Math.cosh],
	tanh: [1, 1, Math.tanh],
	hypot: [1, 20, Math.hypot],
	min: [1, 20, Math.min],
	max: [1, 20, Math.max],
	fact: [1, 1, factorial],
	comb: [2, 2, comb],
	perm: [2, 2, perm],
	gcd: [2, 2, gcd],
	lcm: [2, 2, (a, b) => (a === 0 || b === 0) ? 0 : Math.abs(a * b) / gcd(a, b)],
};

function tokenize(src) {
	let tokens = [];
	let re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*\/%^!(),]))/y;
	let i = 0;
	while (i < src.length) {
		if (/^\s*$/.test(src.slice(i))) {
			break;
		}
		re.lastIndex = i;
		let m = re.exec(src);
		if (!m) {
			throw new Error(`Unexpected character at position ${i + 1}: "${src.slice(i).trimStart()[0]}".`);
		}
		if (m[1] !== undefined) {
			tokens.push({type: "num", value: Number(m[1])});
		} else if (m[2] !== undefined) {
			tokens.push({type: "name", value: m[2].toLowerCase()});
		} else {
			tokens.push({type: "op", value: m[3] === "**" ? "^" : m[3]});
		}
		i = re.lastIndex;
	}
	return tokens;
}

function parse_and_eval(tokens) {

	let pos = 0;
	let depth = 0;

	let peek = () => tokens[pos];
	let is_op = (v) => peek() && peek().type === "op" && peek().value === v;
	let expect = (v) => {
		if (!is_op(v)) {
			throw new Error(`Expected "${v}"${peek() ? ` but found "${peek().value}"` : " at the end"}.`);
		}
		pos++;
	};
	let enter = () => {
		if (++depth > MAX_DEPTH) {
			throw new Error("Expression is nested too deeply.");
		}
	};

	function expr() {
		enter();
		let v = term();
		while (is_op("+") || is_op("-")) {
			let op = tokens[pos++].value;
			let r = term();
			v = op === "+" ? v + r : v - r;
		}
		depth--;
		return v;
	}

	function term() {
		let v = unary();
		while (is_op("*") || is_op("/") || is_op("%")) {
			let op = tokens[pos++].value;
			let r = unary();
			v = op === "*" ? v * r : (op === "/" ? v / r : v % r);
		}
		return v;
	}

	function unary() {
		enter();
		let v;
		if (is_op("-")) {
			pos++;
			v = -unary();
		} else if (is_op("+")) {
			pos++;
			v = unary();
		} else {
			v = power();
		}
		depth--;
		return v;
	}

	function power() {
		let base = postfix();
		if (is_op("^")) {
			pos++;
			return Math.pow(base, unary());
		}
		return base;
	}

	function postfix() {
		let v = primary();
		while (is_op("!")) {
			pos++;
			v = factorial(v);
		}
		return v;
	}

	function primary() {
		let t = peek();
		if (!t) {
			throw new Error("The expression ends too early.");
		}
		if (t.type === "num") {
			pos++;
			return t.value;
		}
		if (is_op("(")) {
			pos++;
			let v = expr();
			expect(")");
			return v;
		}
		if (t.type === "name") {
			pos++;
			if (is_op("(")) {
				if (!Object.hasOwn(FUNCTIONS, t.value)) {
					throw new Error(`Unknown function "${t.value}".`);
				}
				pos++;
				let args = [];
				if (!is_op(")")) {
					args.push(expr());
					while (is_op(",")) {
						pos++;
						args.push(expr());
					}
				}
				expect(")");
				let [min, max, fn] = FUNCTIONS[t.value];
				if (args.length < min || args.length > max) {
					throw new Error(`${t.value} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}.`);
				}
				return fn(...args);
			}
			if (Object.hasOwn(CONSTANTS, t.value)) {
				return CONSTANTS[t.value];
			}
			throw new Error(`Unknown name "${t.value}".`);
		}
		throw new Error(`Unexpected "${t.value}".`);
	}

	let v = expr();
	if (pos < tokens.length) {
		throw new Error(`Unexpected "${tokens[pos].value}" after the end of the expression.`);
	}
	return v;
}

function format_number(v) {
	if (Number.isNaN(v)) {
		throw new Error("The result is undefined (not a number).");
	}
	if (!Number.isFinite(v)) {
		return v > 0 ? "Infinity (too large for double precision)" : "-Infinity (too large for double precision)";
	}
	if (Number.isInteger(v) && Math.abs(v) < 1e21) {
		return Math.abs(v) <= Number.MAX_SAFE_INTEGER ? String(v) : `${v} (approximate: beyond exact integer precision)`;
	}
	let s = v.toPrecision(15);
	if (s.includes("e")) {
		let [m, e] = s.split("e");
		m = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
		return `${m}e${e}`;
	}
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

// Returns the result as a string, or throws with a message meant for the model.

function calculate(expression) {
	if (typeof expression !== "string" || !expression.trim()) {
		throw new Error("expression must be a non-empty string.");
	}
	if (expression.length > MAX_LENGTH) {
		throw new Error(`expression is too long (at most ${MAX_LENGTH} characters).`);
	}
	let tokens = tokenize(expression);
	if (tokens.length === 0) {
		throw new Error("expression is empty.");
	}
	return format_number(parse_and_eval(tokens));
}

const NAMES_HELP = `Operators: + - * / % ^ (or **) and ! (factorial). Constants: ${Object.keys(CONSTANTS).join(", ")}. Functions: ${Object.keys(FUNCTIONS).join(", ")}. log(x) is base 10; log(x, b) is base b; ln is natural. Angles are in radians.`;

module.exports = {calculate, NAMES_HELP};
