import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Images a commit confirmed for a session, by hex SHA-256: the session's
 * later captures do not list them again (every listed image counts against
 * the capture's image budget, even one the server stores already). Kept per
 * endpoint, workspace and session, and bounded; the oldest entries go first.
 * Losing an entry costs only budget: the image is declared again and the
 * server, which has it, does not ask for its bytes.
 */
export interface ImageLedgerScope {
	readonly endpoint: string;
	readonly organizationId: string;
	readonly source: string;
	readonly sessionId: string;
}

export const DELIVERED_IMAGE_LEDGER_MAX_ENTRIES = 20_000;
const COMPACTED_ENTRIES = 16_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export async function readDeliveredImages(
	configDir: string,
	scope: ImageLedgerScope,
): Promise<ReadonlySet<string>> {
	try {
		const text = await readFile(getLedgerPath(configDir, scope), "utf8");
		return new Set(
			text.split("\n").filter((line) => SHA256_PATTERN.test(line)),
		);
	} catch {
		return new Set();
	}
}

export async function recordDeliveredImages(
	configDir: string,
	scope: ImageLedgerScope,
	sha256s: readonly string[],
): Promise<void> {
	const fresh = sha256s.filter((sha256) => SHA256_PATTERN.test(sha256));
	if (fresh.length === 0) return;
	const directory = join(configDir, "repository-evidence-images");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(directory, 0o700);
	const path = getLedgerPath(configDir, scope);
	const known = await readDeliveredImages(configDir, scope);
	const added = [...new Set(fresh)].filter((sha256) => !known.has(sha256));
	if (added.length === 0) return;
	if (known.size + added.length <= DELIVERED_IMAGE_LEDGER_MAX_ENTRIES) {
		await appendFile(path, `${added.join("\n")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		return;
	}
	const kept = [...known, ...added].slice(-COMPACTED_ENTRIES);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${kept.join("\n")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function getLedgerPath(configDir: string, scope: ImageLedgerScope): string {
	const key = createHash("sha256")
		.update(
			[
				scope.endpoint,
				scope.organizationId,
				scope.source,
				scope.sessionId,
			].join("\u0000"),
			"utf8",
		)
		.digest("hex");
	return join(configDir, "repository-evidence-images", `${key}.txt`);
}
