import { expect, test } from "bun:test";
import {
	formatUploadReview,
	type UploadRepositoryOption,
} from "../lib/upload-review.js";

test("a bounded review counts every selected project and session", () => {
	const repositories = Array.from({ length: 40 }, (_, index) => ({
		key: `repo-${index}`,
		label: `repo-${index}`,
		pickerLabel: `repo-${index}`,
		sessionCount: index + 1,
		destination: "My workspace",
	}));
	const review = formatUploadReview(repositories, { rows: 20, columns: 80 });
	expect(review).toContain("40 projects · 820 sessions");
	expect(review).toContain("Destination: My workspace");
	expect(review).toContain("… and 34 more projects");
	// The prompt needs additional rows for borders, actions, and keyboard hints.
	expect(review.split("\n").length).toBeLessThanOrEqual(13);
});

test("a narrow review preserves counts when repository names are long", () => {
	const review = formatUploadReview(
		[
			{
				key: "long",
				label: "a".repeat(200),
				pickerLabel: "unused",
				sessionCount: 1234,
				destination: "My workspace",
			},
		],
		{ rows: 20, columns: 40 },
	);
	expect(review).toContain("…  1234 sessions");
	for (const line of review.split("\n"))
		expect(line.length).toBeLessThanOrEqual(40);
});

test("a review identifies separate destinations without rendering control characters", () => {
	const repositories: UploadRepositoryOption[] = [
		{
			key: "first",
			label: "first\x1b[2J",
			pickerLabel: "first",
			sessionCount: 10,
			destination: "Team A",
		},
		{
			key: "second",
			label: "second",
			pickerLabel: "second",
			sessionCount: 20,
			destination: "Team B",
		},
	];
	const review = formatUploadReview(repositories, { rows: 24, columns: 80 });
	expect(review).toContain("Multiple workspaces");
	expect(review).toContain("10 sessions → Team A");
	expect(review).toContain("20 sessions → Team B");
	expect(review).not.toContain("\x1b");
});
