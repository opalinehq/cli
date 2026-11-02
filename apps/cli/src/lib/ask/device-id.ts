import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir, writePrivateFile } from "../local-state.js";

const DEVICE_ID_FILE = "ask-device-id";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/u;

export async function loadDeviceId(
	configDir: string = getConfigDir(),
): Promise<string> {
	const path = join(configDir, DEVICE_ID_FILE);
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	if (DEVICE_ID_PATTERN.test(existing)) return existing;
	const deviceId = randomUUID();
	await writePrivateFile(path, `${deviceId}\n`, configDir);
	return deviceId;
}
