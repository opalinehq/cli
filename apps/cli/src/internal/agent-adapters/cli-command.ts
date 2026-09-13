import { basename } from "node:path";

export function getCliCommand(
	entrypoint: string | undefined = process.argv[1],
): "opaline" | "rudel" {
	// A global rudel install exposes only its own bin, not its dependency's bin.
	const executable = basename((entrypoint ?? "").replaceAll("\\", "/"));
	return executable === "rudel" || executable === "rudel.js"
		? "rudel"
		: "opaline";
}
