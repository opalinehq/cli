import { expect, test } from "bun:test";
import { filterKnownSecrets } from "../secret-filter/index.js";
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
		filterKnownSecrets(`/tmp/${token}`).text,
	);
	for (const resource of [
		filtered.entries[0],
		filtered.documents[0],
		filtered.index.resources[0],
		filtered.error,
		filtered.git,
	]) {
		expect(resource?.path).toBe(filterKnownSecrets(path).text);
	}
	expect(filtered.root.label).toBe(filtered.index.skills[0]?.name ?? "");
	expect(filtered.symlink.target).toBe(filtered.entries[0]?.path ?? "");
	expect(filtered.count).toBe(42);
	expect(filtered.missing).toBeNull();
	expect(filtered.omitted).toBeUndefined();
	expect(filtered.included).toBe(true);
	expect(filterContextMetadata(filtered)).toEqual(filtered);
});
