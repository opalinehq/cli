import { describe, expect, test } from "bun:test";
import { parseGitHubRepositoryRemoteHint } from "../lib/repo-context.js";

describe("GitHub repository remote hints", () => {
	test.each([
		["github.com/opalinehq/athena", "opalinehq", "athena"],
		["https://github.com/OpalineHQ/Athena.git", "OpalineHQ", "Athena"],
		["git@github.com:opalinehq/athena.git", "opalinehq", "athena"],
	])("parses %s without credentials or paths", (remote, owner, name) => {
		expect(parseGitHubRepositoryRemoteHint(remote)).toEqual({
			host: "github.com",
			name,
			owner,
			provider: "github",
		});
	});

	test.each([
		"gitlab.com/opalinehq/athena",
		"github.com/opalinehq/athena/subdirectory",
		"github.com/opalinehq",
		"github.com/../athena",
	])("does not claim unsupported or malformed remote %s", (remote) => {
		expect(parseGitHubRepositoryRemoteHint(remote)).toBeNull();
	});
});
