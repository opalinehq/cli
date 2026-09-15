export type TerminalMode = "dark" | "light";

const PALETTES = {
	dark: {
		background: "#171918",
		foreground: "#dddcd7",
		colors: [
			"#222222",
			"#eb7b7b",
			"#8ccc91",
			"#e5bf73",
			"#82a9dd",
			"#c798cd",
			"#80c9d4",
			"#dddcd7",
		],
	},
	light: {
		background: "#faf9f6",
		foreground: "#242424",
		colors: [
			"#242424",
			"#aa2424",
			"#28763a",
			"#8b5e0b",
			"#285daa",
			"#86478a",
			"#087c91",
			"#555555",
		],
	},
};
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function terminalPalette(mode: TerminalMode) {
	return PALETTES[mode];
}

export function renderAnsiLines(
	ansi: string,
	mode: TerminalMode,
): HTMLDivElement[] {
	const palette = PALETTES[mode];
	return ansi.split("\n").map((line) => {
		const row = document.createElement("div");
		row.className = "terminal-row";
		const accessibleText: string[] = [];
		let column = 0;
		let color = palette.foreground;
		let bold = false;
		let dim = false;
		let inverse = false;
		let underline = false;
		let href: string | undefined;
		function append(text: string) {
			if (!text) return;
			accessibleText.push(text);
			const span = document.createElement(href ? "a" : "span");
			if (span instanceof HTMLAnchorElement && href) {
				span.href = href;
				span.target = "_blank";
				span.rel = "noopener noreferrer";
				span.setAttribute("aria-label", text);
			} else span.setAttribute("aria-hidden", "true");
			// Glyph fallback fonts must not change terminal cell widths. In particular,
			// circles and brackets get the same centered cell in either switch state.
			for (const { segment } of GRAPHEMES.segment(text)) {
				const cell = document.createElement("i");
				cell.textContent = segment;
				cell.style.width = `${cellWidth(segment)}ch`;
				span.append(cell);
			}
			if (/^ ?\[[─●○]{3}\] $/u.test(text)) {
				span.className = "switch-track";
				const position = [...text].findIndex(
					(char) => char === "●" || char === "○",
				);
				const knob = span.children[position];
				if (knob instanceof HTMLElement) {
					knob.className = "switch-knob";
					knob.dataset.position = String(position);
				}
			}
			span.style.setProperty("--column", String(column));
			span.style.setProperty("--color", inverse ? palette.background : color);
			span.style.setProperty("--background", inverse ? color : "transparent");
			if (inverse) span.style.setProperty("--knob-bg", color);
			span.style.setProperty("--weight", bold ? "700" : "400");
			span.style.setProperty("--opacity", dim ? "0.58" : "1");
			span.style.setProperty("--decoration", underline ? "underline" : "none");
			row.append(span);
			for (const { segment } of GRAPHEMES.segment(text))
				column += cellWidth(segment);
		}
		const [first = "", ...sequences] = line.split("\u001b");
		append(first);
		for (const sequence of sequences) {
			const linkEnd = sequence.indexOf("\u0007");
			if (sequence.startsWith("]8;;") && linkEnd >= 4) {
				const target = sequence.slice(4, linkEnd);
				href =
					/^https?:\/\//u.test(target) && !/\p{Cc}/u.test(target)
						? target
						: undefined;
				append(sequence.slice(linkEnd + 1));
				continue;
			}
			const match = /^\[([\d;]+)([mG])([\s\S]*)$/u.exec(sequence);
			if (!match) continue;
			if (match[2] === "G") column = Number(match[1]) - 1;
			else {
				const codes = (match[1] ?? "0").split(";").map(Number);
				for (let index = 0; index < codes.length; index++) {
					const code = codes[index];
					if (code === 0) {
						color = palette.foreground;
						bold = false;
						dim = false;
						inverse = false;
						underline = false;
					} else if (code === 1) bold = true;
					else if (code === 2) dim = true;
					else if (code === 4) underline = true;
					else if (code === 7) inverse = true;
					else if (code === 38 && codes[index + 1] === 2) {
						color = `rgb(${codes
							.slice(index + 2, index + 5)
							.map((value) => Math.min(255, Math.max(0, value)))
							.join(",")})`;
						index += 4;
					} else if (code !== undefined && code >= 30 && code <= 37)
						color = palette.colors[code - 30] ?? palette.foreground;
				}
			}
			append(match[3] ?? "");
		}
		// Expose complete lines, so assistive technology does not read cell-by-cell.
		row.setAttribute("role", "group");
		row.setAttribute(
			"aria-label",
			accessibleText.join(" ").replace(/\s+/gu, " ").trim(),
		);
		return row;
	});
}

function cellWidth(segment: string): number {
	return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(
		segment,
	)
		? 2
		: 1;
}
