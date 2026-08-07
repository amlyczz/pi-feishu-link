// 像素画封面生成器：Pi × Feishu 桥接主题（纯 JS）
// 输出 assets/preview.svg（README 用）+ 供 Playwright 转 preview.png（pi.image 用）
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const W = 60;
const H = 32;
const SCALE = 20; // 每像素 20px → 1200x640

const PAL = {
	B: "#0b1026",
	b: "#131a3e",
	s: "#7ee0ff",
	S: "#e8ecff",
	W: "#ffffff",
	P: "#37d67a",
	g: "#1d5c3a",
	G: "#0f2f20",
	F: "#3370ff",
	f: "#1e4bb8",
	d: "#8fb3ff",
	c: "#4dd7fe",
	y: "#ffd54a",
	r: "#ff5d8f",
	o: "#ff9d45",
};

const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => "B"));

function fill(x0, y0, w, h, key) {
	for (let y = y0; y < Math.min(H, y0 + h); y++)
		for (let x = x0; x < Math.min(W, x0 + w); x++) grid[y][x] = key;
}

function px(x, y, key) {
	if (x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = key;
}

// ---- 背景：星空（确定性伪随机） ----
let seed = 42;
function rnd() {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
}
for (let i = 0; i < 60; i++) {
	const x = Math.floor(rnd() * W);
	const y = Math.floor(rnd() * H);
	if (grid[y][x] === "B") grid[y][x] = rnd() > 0.5 ? "s" : "S";
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y][x] === "B" && y > 24) grid[y][x] = "b";

// ---- 左：Pi 终端窗口 ----
fill(2, 3, 18, 14, "c");
fill(3, 4, 16, 12, "G");
fill(3, 4, 16, 2, "g");
px(5, 4, "P"); px(6, 4, "P"); px(5, 5, "P");
px(8, 4, "s"); px(9, 4, "s"); px(10, 4, "s");
fill(4, 7, 14, 1, "#0d2418");
px(5, 7, "P"); px(6, 7, "P");
for (let i = 8; i < 17; i++) px(i, 7, "g");
fill(4, 9, 14, 1, "#0d2418");
px(5, 9, "P"); px(6, 9, "P");
for (let i = 8; i < 15; i += 2) px(i, 9, "g");
fill(4, 11, 14, 1, "#0d2418");
for (let i = 5; i < 13; i += 2) px(i, 11, "g");
fill(3, 14, 16, 2, "g");
px(5, 14, "P"); px(6, 14, "P"); px(7, 14, "P");
for (let i = 10; i < 16; i++) px(i, 15, "#0d2418");

// ---- 右：飞书机器人 Logo ----
fill(40, 3, 16, 14, "F");
px(40, 3, "B"); px(55, 3, "B"); px(40, 16, "B"); px(55, 16, "B");
fill(44, 7, 8, 2, "W");
fill(46, 5, 4, 2, "W");
fill(45, 9, 7, 2, "W");
px(47, 11, "W"); px(48, 11, "W"); px(49, 11, "W");
for (let i = 41; i < 44; i++) px(i, 4, "d");
px(41, 5, "d");
fill(48, 14, 6, 2, "d");
px(50, 16, "d");

// ---- 中：双向连接箭头 ----
for (let x = 21; x < 39; x++) {
	px(x, 9, "c");
	px(x, 10, "c");
}
px(21, 8, "c"); px(22, 8, "c"); px(21, 11, "c"); px(22, 11, "c");
px(37, 8, "c"); px(38, 8, "c"); px(37, 11, "c"); px(38, 11, "c");
px(26, 9, "y"); px(27, 9, "y");
px(32, 10, "o");
px(24, 10, "s");
px(29, 8, "W"); px(30, 8, "W");
px(29, 11, "W"); px(30, 11, "W");

// ---- 像素文字：PI × FEISHU ----
const FONT = {
	P: ["01110", "10001", "10001", "11110", "10000", "10000", "10000"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
	F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
};
function drawText(text, startX, startY, key, spacing = 2) {
	let cx = startX;
	for (const ch of text) {
		if (ch === " ") {
			cx += 5 + spacing;
			continue;
		}
		const glyph = FONT[ch];
		if (!glyph) {
			cx += 5 + spacing;
			continue;
		}
		for (let gy = 0; gy < 7; gy++)
			for (let gx = 0; gx < 5; gx++)
				if (glyph[gy]?.[gx] === "1") px(cx + gx, startY + gy, key);
		cx += 5 + spacing;
	}
}
drawText("PI", 15, 18, "P", 2);
drawText("X", 27, 18, "r", 2);
drawText("FEISHU", 35, 18, "F", 2);

const SUB = {
	L: ["100", "100", "100", "100", "111"],
	I: ["111", "010", "010", "010", "111"],
	N: ["100", "110", "101", "101", "100"],
	K: ["101", "110", "100", "110", "101"],
};
function drawSub(text, startX, startY, key, spacing = 2) {
	let cx = startX;
	for (const ch of text) {
		const glyph = SUB[ch];
		if (!glyph) {
			cx += 3 + spacing;
			continue;
		}
		for (let gy = 0; gy < 5; gy++)
			for (let gx = 0; gx < 3; gx++)
				if (glyph[gy]?.[gx] === "1") px(cx + gx, startY + gy, key);
		cx += 3 + spacing;
	}
}
drawSub("LINK", 23, 27, "c", 2);

// ---- 底部装饰 ----
fill(3, 27, 5, 2, "s");
fill(4, 26, 3, 1, "s");
px(3, 29, "s");
fill(52, 27, 5, 2, "s");
fill(53, 26, 3, 1, "s");
px(56, 29, "s");
for (let x = 2; x < W - 2; x += 4) px(x, 30, rnd() > 0.5 ? "s" : "S");

// ---- 输出 SVG ----
const rects = [];
for (let y = 0; y < H; y++) {
	for (let x = 0; x < W; x++) {
		const k = grid[y][x];
		if (k === "B") continue;
		rects.push(
			`<rect x="${x * SCALE}" y="${y * SCALE}" width="${SCALE}" height="${SCALE}" fill="${PAL[k] ?? "#fff"}"/>`,
		);
	}
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W * SCALE} ${H * SCALE}" shape-rendering="crispEdges">
<rect width="${W * SCALE}" height="${H * SCALE}" fill="#0b1026"/>
${rects.join("")}
</svg>`;

mkdirSync(join(process.cwd(), "assets"), { recursive: true });
writeFileSync(join(process.cwd(), "assets", "preview.svg"), svg);
console.log(`preview.svg 已生成 (${W}x${H} 像素, ${W * SCALE}x${H * SCALE}px)`);
