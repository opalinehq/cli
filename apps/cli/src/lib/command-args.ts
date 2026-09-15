export function getCommandArgs(args: readonly string[]): string[] {
	// Preserve the browser's one-command entry without adding another command
	// to the normal upload manager's help screen.
	if (
		args[0]?.startsWith("--") &&
		args.some((arg) => arg === "--code" || arg.startsWith("--code="))
	)
		return ["connect", ...args];
	// Existing file-upload scripts keep working alongside the toggle manager.
	if (
		args[0] === "upload" &&
		args.length > 1 &&
		!args.includes("--help") &&
		!args.includes("-h")
	)
		return ["import", ...args.slice(1)];
	if (args.length === 1 && (args[0] === "enable" || args[0] === "disable"))
		return ["upload"];
	return [...args];
}
