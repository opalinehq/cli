import { expect, test } from "bun:test";
import {
	compareCliVersions,
	getCliReleaseUrl,
	readCliBundleVersion,
} from "../lib/cli-release.js";
import { shouldOfferCliUpdate } from "../lib/cli-update.js";

test("release links identify the exact reviewed version and reject URL injection", () => {
	expect(getCliReleaseUrl("0.9.0")).toBe(
		"https://github.com/opalinehq/cli/releases/tag/opaline-cli%400.9.0",
	);
	expect(getCliReleaseUrl("1.0.0-rc.1+build.2")).toEndWith(
		"opaline-cli%401.0.0-rc.1%2Bbuild.2",
	);
	for (const value of [
		"latest",
		"0.9.0\n",
		"0.9.0/../../evil",
		"01.2.3",
		"1.0.0-01",
		"1.0.0;echo nope",
	])
		expect(() => getCliReleaseUrl(value)).toThrow();
});

test("upgrade ordering follows SemVer including prereleases and large identifiers", () => {
	const versions = [
		"0.9.0",
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
		"1.0.1",
		"2.0.0",
		"99999999999999999999.0.0",
	];
	for (let i = 0; i < versions.length - 1; i++) {
		const a = versions[i] ?? "";
		const b = versions[i + 1] ?? "";
		expect(compareCliVersions(a, b)).toBe(-1);
		expect(compareCliVersions(b, a)).toBe(1);
	}
	expect(compareCliVersions("1.0.0+one", "1.0.0+two")).toBe(0);
	expect(compareCliVersions("0.9.0", "0.9.0")).toBe(0);
});

test("reads the published bundle manifest without evaluating JavaScript", () => {
	expect(
		readCliBundleVersion(
			'throw new Error("do not run");\nvar pkg = {name: "@opalinehq/cli", version: "0.8.1"};',
		),
	).toBe("0.8.1");
	expect(
		readCliBundleVersion('name: "other", version: "99.0.0"'),
	).toBeUndefined();
});

test("automatic checks only run for ordinary interactive commands", () => {
	for (const args of [
		[],
		["upload"],
		["login"],
		["whoami"],
		["enable"],
		["disable"],
	]) {
		expect(shouldOfferCliUpdate(args, true, false)).toBe(true);
		expect(shouldOfferCliUpdate(args, false, false)).toBe(false);
		expect(shouldOfferCliUpdate(args, true, true)).toBe(false);
	}
	for (const args of [
		["--code", "secret"],
		["connect"],
		["hooks"],
		["update"],
		["doctor"],
		["--version"],
		["-v"],
		["--help"],
		["upload", "--help"],
		["import", "session.jsonl"],
	])
		expect(shouldOfferCliUpdate(args, true, false)).toBe(false);
});
