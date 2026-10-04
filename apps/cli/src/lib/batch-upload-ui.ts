import { box, progress } from "@clack/prompts";
import {
	type BatchUploadItem,
	type BatchUploadOptions,
	type BatchUploadSummary,
	batchUpload,
} from "./batch-upload.js";
import { formatRedactionSummary } from "./uploader.js";

export interface BatchProgressOptions<T extends BatchUploadItem> {
	items: T[];
	upload: BatchUploadOptions<T>["upload"];
	label: string;
	concurrency?: number;
}

export async function runBatchUpload<T extends BatchUploadItem>(
	options: BatchProgressOptions<T>,
): Promise<BatchUploadSummary> {
	const { items, upload, label, concurrency } = options;

	const bar = progress({ max: items.length });
	bar.start(label);

	const summary = await batchUpload({
		items,
		upload,
		concurrency,
		onItemComplete: (completed, total) => {
			bar.advance(1, `[${completed}/${total}] ${label}`);
		},
		onRetry: (itemLabel, attempt, maxAttempts, error) => {
			bar.message(
				`Retrying ${itemLabel} (${attempt}/${maxAttempts}) after ${error}`,
			);
		},
	});

	bar.stop(
		summary.failed > 0
			? `Completed with ${summary.failed} error(s)`
			: summary.skipped > 0
				? `Completed with ${summary.skipped} skipped`
				: "Upload complete",
	);

	return summary;
}

export interface SummaryDisplayOptions {
	context?: string;
	maxErrors?: number;
	showRetryHint?: boolean;
}

export function renderBatchSummary(
	summary: BatchUploadSummary,
	options?: SummaryDisplayOptions,
): void {
	const { context, maxErrors = 5, showRetryHint = false } = options ?? {};
	const prefix = context ? `${context}: ` : "";
	const lines: string[] = [];

	if (summary.succeeded > 0) {
		lines.push(`${prefix}${summary.succeeded} session(s) uploaded`);
	}
	const redactionSummary = formatRedactionSummary(
		summary.redacted,
		summary.redactedBytes,
	);
	if (redactionSummary) {
		lines.push(`${prefix}${redactionSummary}`);
	}
	if (summary.pending > 0) {
		lines.push(
			`${prefix}${summary.pending} session(s) accepted and still processing on the server; they are checked on the next upload or \`opaline upload --retry\``,
		);
	}
	if (summary.failed > 0) {
		lines.push(`${prefix}${summary.failed} session(s) failed`);
		for (const err of summary.errors.slice(0, maxErrors)) {
			lines.push(`  ${err.label}: ${err.error}`);
		}
		if (summary.errors.length > maxErrors) {
			lines.push(`  ...and ${summary.errors.length - maxErrors} more`);
		}
	}
	if (summary.skipped > 0) {
		lines.push(`${prefix}${summary.skipped} session(s) skipped`);
		for (const item of summary.skippedItems.slice(0, maxErrors)) {
			lines.push(`  ${item.label}: ${item.reason}`);
		}
		if (summary.skippedItems.length > maxErrors) {
			lines.push(`  ...and ${summary.skippedItems.length - maxErrors} more`);
		}
	}

	if (showRetryHint && summary.failed > 0) {
		lines.push("");
		lines.push("Run `opaline upload --retry` to retry failed uploads.");
	}

	if (lines.length > 0) {
		box(lines.join("\n"), "Upload Summary");
	}
}
