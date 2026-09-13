import { randomBytes } from "node:crypto";
import {
	CLI_CONNECTION_PATH,
	CliConnectionSecretSchema,
	type CliConnectionSnapshot,
	CliConnectionSnapshotSchema,
	type CliConnectionUpdate,
} from "../contracts/cli-connection.js";
import type { Credentials } from "./credentials.js";

export async function connectBrowser(apiBase: string, code: string) {
	CliConnectionSecretSchema.parse(code);
	const writerToken = randomBytes(32).toString("base64url");
	const initial = await requestConnection(
		`${apiBase}${CLI_CONNECTION_PATH}/redeem`,
		{ code, writerToken },
	);
	let sequence = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let stopped = false;
	let heartbeatFailure: unknown;

	function update(
		update: CliConnectionUpdate["update"],
		credentials?: Credentials,
	): Promise<CliConnectionSnapshot> {
		const pending = queue.then(async () => {
			if (heartbeatFailure) throw heartbeatFailure;
			const snapshot = await requestConnection(
				`${apiBase}${CLI_CONNECTION_PATH}/${initial.id}/update`,
				{ writerToken, sequence: sequence + 1, update },
				credentials,
			);
			sequence++;
			return snapshot;
		});
		queue = pending.catch(() => {});
		return pending;
	}
	const heartbeat = setInterval(() => {
		if (!stopped)
			void update({ kind: "heartbeat" }).catch((error: unknown) => {
				heartbeatFailure = error;
			});
	}, 30_000);
	heartbeat.unref();
	return {
		id: initial.id,
		browserOrigin: initial.browserOrigin,
		update,
		stop() {
			stopped = true;
			clearInterval(heartbeat);
		},
	};
}

async function requestConnection(
	url: string,
	body: unknown,
	credentials?: Credentials,
): Promise<CliConnectionSnapshot> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (credentials) {
		if (credentials.authType === "api-key")
			headers["X-API-Key"] = credentials.token;
		else headers.Authorization = `Bearer ${credentials.token}`;
	}
	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
				redirect: "error",
			});
		} catch (error) {
			if (attempt >= 2)
				throw new Error(
					"Could not connect to the demo. Check your connection and copy a fresh command.",
					{ cause: error },
				);
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
			continue;
		}
		if (response.status >= 500 && attempt < 2) {
			await response.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			if (
				response.status === 404 ||
				response.status === 410 ||
				response.status === 409
			)
				throw new Error(
					"This connection code expired or was already used. Copy a fresh command from the demo.",
				);
			if (response.status === 403)
				throw new Error(
					"Approve this connection in the same browser where you copied the command.",
				);
			throw new Error(
				`The demo connection failed (${response.status}). Please try again.`,
			);
		}
		return CliConnectionSnapshotSchema.parse(await response.json());
	}
}
