import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AgentAdapter } from "../internal/agent-adapters/index.js";
import type { AutoUploadHookResult } from "./auto-upload-analytics.js";
import type { UploadRepository } from "./upload-manager-repositories.js";

// Called under the settings lock. Validate all agents before any hook mutation;
// roll back completed writes if installation or local-hook cleanup fails.
export function migrateAutoUploadHooks(
	repositories: UploadRepository[],
	adapters: AgentAdapter[],
	enabling: boolean,
	onResult: (result: AutoUploadHookResult) => void,
): void {
	const plans = adapters.flatMap((adapter) => {
		const globalPath = adapter.getHookConfigPath({ global: true });
		const localPaths =
			adapter.source === "claude_code"
				? [
						...new Set(
							repositories.flatMap((repo) => repo.paths.filter(existsSync)),
						),
					].filter(
						(projectPath) =>
							adapter.getHookConfigPath({ projectPath }) !== globalPath &&
							adapter.isHookInstalled({ projectPath }),
					)
				: [];
		const alreadyInstalled = adapter.isHookInstalled({ global: true });
		if (!enabling && !alreadyInstalled && !localPaths.length) return [];
		try {
			adapter.validateHook({ global: true });
		} catch (error) {
			onResult({ source: adapter.source, status: "failed", error });
			throw error;
		}
		return [{ adapter, globalPath, localPaths, alreadyInstalled }];
	});
	const paths = plans.flatMap(({ adapter, globalPath, localPaths }) => [
		globalPath,
		...localPaths.map((projectPath) =>
			adapter.getHookConfigPath({ projectPath }),
		),
	]);
	updateHookSettings(paths, () => {
		for (const { adapter, localPaths } of plans) {
			try {
				adapter.installHook({ global: true });
				for (const projectPath of localPaths)
					adapter.removeHook({ projectPath });
			} catch (error) {
				onResult({ source: adapter.source, status: "failed", error });
				throw error;
			}
		}
	});
	for (const { adapter, alreadyInstalled } of plans)
		onResult({ source: adapter.source, status: "enabled", alreadyInstalled });
}

// Snapshot the agent files before a synchronous migration. This also restores
// local hooks already removed when a later filesystem write fails.
export function updateHookSettings(paths: string[], update: () => void): void {
	const originals = new Map(
		paths.map((path) => [
			path,
			existsSync(path) ? readFileSync(path, "utf8") : undefined,
		]),
	);
	try {
		update();
	} catch (error) {
		const errors: unknown[] = [error];
		for (const [path, content] of originals) {
			try {
				if (content === undefined) rmSync(path, { force: true });
				else if (!existsSync(path) || readFileSync(path, "utf8") !== content)
					writeFileSync(path, content);
			} catch (rollbackError) {
				errors.push(rollbackError);
			}
		}
		if (errors.length > 1)
			throw new AggregateError(
				errors,
				"Hook setup failed and could not fully restore the previous settings. Run `opaline upload` to repair setup.",
			);
		throw error;
	}
}
