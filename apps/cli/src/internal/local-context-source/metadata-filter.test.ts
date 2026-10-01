import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { filterContextMetadata } from "./metadata-filter.js";

test("filters every nested metadata string without changing references or non-string values", () => {
	const token = `ghp_${"AbCdEf0123456789".repeat(3).slice(0, 36)}`;
	const path = `${token}/AGENTS.md`;
	const reference = { rootId: "repository", path };
	const metadata = {
		root: { absolutePath: `/tmp/${token}`, label: token },
		entries: [{ ...reference, name: "AGENTS.md", parentPath: token }],
		documents: [reference],
		index: { resources: [reference], skills: [{ name: token }] },
		symlink: { target: path },
		error: { path, detail: `Cannot read ${path}` },
		git: { path, originalPath: path, branch: token, authorName: token },
		count: 42,
		missing: null,
		omitted: undefined,
		included: true,
	};
	const filtered = filterContextMetadata(metadata);
	expect(JSON.stringify(filtered)).not.toContain(token);
	expect(JSON.stringify(metadata)).toContain(token);
	expect(filtered.root.absolutePath).toBe(
		filterContextMetadata(`/tmp/${token}`),
	);
	for (const resource of [
		filtered.entries[0],
		filtered.documents[0],
		filtered.index.resources[0],
		filtered.error,
		filtered.git,
	]) {
		expect(resource?.path).toBe(filterContextMetadata(path));
	}
	expect(filtered.root.label).toBe(filtered.index.skills[0]?.name ?? "");
	expect(filtered.symlink.target).toBe(filtered.entries[0]?.path ?? "");
	expect(filtered.count).toBe(42);
	expect(filtered.missing).toBeNull();
	expect(filtered.omitted).toBeUndefined();
	expect(filtered.included).toBe(true);
	expect(filterContextMetadata(filtered)).toEqual(filtered);
});

test.each(["/", "\\"])(
	"filters npm tokens in every path segment while preserving references (%s)",
	(separator) => {
		const token = `npm_${"a".repeat(36)}`;
		const parentPath = [".claude", "skills", token].join(separator);
		const path = [parentPath, "SKILL.md"].join(separator);
		const filtered = filterContextMetadata({
			path,
			parentPath,
			name: token,
			reference: { path },
		});
		const marker = `[REDACTED:npm-access-token:${createHash("sha256").update(token).digest("hex").slice(0, 12)}]`;
		expect(JSON.stringify(filtered)).not.toContain(token);
		expect(filtered.name).toBe(marker);
		expect(filtered.parentPath).toBe(
			[".claude", "skills", marker].join(separator),
		);
		expect(filtered.path).toBe(
			[filtered.parentPath, "SKILL.md"].join(separator),
		);
		expect(filtered.reference.path).toBe(filtered.path);
		expect(filterContextMetadata(filtered)).toEqual(filtered);
	},
);

test("uses the matched secret hash consistently without collapsing distinct names", () => {
	const tokens = [`ghp_${"A".repeat(36)}`, `ghp_${"B".repeat(36)}`];
	const filtered = tokens.map((token) =>
		filterContextMetadata({
			name: token,
			path: `.claude/skills/${token}/SKILL.md`,
			filename: `${token}.md`,
			observed: [token],
		}),
	);
	for (const [index, token] of tokens.entries()) {
		const marker = `[REDACTED:github-pat:${createHash("sha256").update(token).digest("hex").slice(0, 12)}]`;
		expect(filtered[index]).toEqual({
			name: marker,
			path: `.claude/skills/${marker}/SKILL.md`,
			filename: `${marker}.md`,
			observed: [marker],
		});
	}
	expect(filtered[0]?.name).not.toBe(filtered[1]?.name);
});

test("preserves whole-string secret filtering when a secret contains path separators", () => {
	const key = `-----BEGIN PRIVATE KEY-----\n${"a/".repeat(64)}\n-----END PRIVATE KEY-----`;
	expect(filterContextMetadata(key)).toBe(
		`[REDACTED:private-key:${createHash("sha256").update(key).digest("hex").slice(0, 12)}]`,
	);
});

test("filters tokens followed by a suffix in names, paths and remote hints", () => {
	const token = `npm_${"b".repeat(36)}`;
	const marker = `[REDACTED:npm-access-token:${createHash("sha256").update(token).digest("hex").slice(0, 12)}]`;
	const filtered = filterContextMetadata({
		document: `docs/${token}.md`,
		skill: `.claude/skills/${token}.guide/SKILL.md`,
		remoteHint: `git@github.com:fixture/${token}.guide.git`,
		windowsPath: `C:\\repo\\${token}.md`,
	});
	expect(JSON.stringify(filtered)).not.toContain(token);
	expect(filtered.document).toBe(`docs/${marker}.md`);
	expect(filtered.skill).toBe(`.claude/skills/${marker}.guide/SKILL.md`);
	expect(filtered.remoteHint).toBe(
		`git@github.com:fixture/${marker}.guide.git`,
	);
	expect(filterContextMetadata(filtered)).toEqual(filtered);
});
