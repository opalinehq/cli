export function extractObservedSkills(session: {
	readonly content: string;
	readonly subagents?: readonly { readonly content: string }[];
}): readonly string[] {
	return [
		...new Set(
			[
				session.content,
				...(session.subagents ?? []).map((agent) => agent.content),
			].flatMap(extractTranscriptSkills),
		),
	].sort();
}

export function extractTranscriptSkills(content: string): readonly string[] {
	let codex = false;
	for (const type of recordTypes(content)) {
		if (
			["session_meta", "turn_context", "response_item", "event_msg"].includes(
				type,
			)
		) {
			codex = true;
			break;
		}
	}
	const skills = new Set<string>();
	for (const record of transcriptRecords(content))
		collectObservedSkills(record, skills, codex);
	return [...skills].sort();
}

function* recordTypes(content: string): Generator<string> {
	for (const record of transcriptRecords(content))
		if (isRecord(record) && typeof record.type === "string") yield record.type;
}

function* transcriptRecords(content: string): Generator<unknown> {
	for (let cursor = 0; cursor < content.length; ) {
		const newline = content.indexOf("\n", cursor);
		const end = newline < 0 ? content.length : newline;
		try {
			yield JSON.parse(content.slice(cursor, end));
		} catch {}
		cursor = end + 1;
	}
}

function collectObservedSkills(
	value: unknown,
	skills: Set<string>,
	codex: boolean,
): void {
	if (Array.isArray(value)) {
		for (const item of value) collectObservedSkills(item, skills, codex);
		return;
	}
	if (!isRecord(value)) return;
	let input = isRecord(value.input) ? value.input : undefined;
	if (codex && value.type === "function_call") {
		try {
			const argumentsValue: unknown =
				typeof value.arguments === "string"
					? JSON.parse(value.arguments)
					: value.arguments;
			if (isRecord(argumentsValue)) input = argumentsValue;
		} catch {}
	}
	const name = typeof value.name === "string" ? value.name : undefined;
	const toolName = name?.split(/\.|__/u).at(-1)?.toLowerCase();
	if (toolName === "skill") {
		const skill = input?.skill;
		if (typeof skill === "string" && skill.trim()) skills.add(skill.trim());
	}
	const path = input?.file_path ?? input?.path;
	if (typeof path === "string") addSkillPath(path, skills);
	if (
		codex &&
		["exec_command", "shell", "shell_command"].includes(toolName ?? "")
	) {
		const command = input?.cmd ?? input?.command;
		const text = Array.isArray(command) ? command.join(" ") : command;
		if (
			typeof text === "string" &&
			/(?:^|[;&|])\s*(?:cat|head|tail|less|more|sed|awk|rg|grep|bat)\s/u.test(
				text,
			)
		) {
			for (const token of text.split(/[\s"'`;&|()]/u))
				addSkillPath(token, skills);
		}
	}
	for (const nested of Object.values(value))
		collectObservedSkills(nested, skills, codex);
}

function addSkillPath(path: string, skills: Set<string>): void {
	const match = /(?:^|\/)([^/]+)\/SKILL(?:\.md)?$/iu.exec(
		path.replaceAll("\\", "/"),
	);
	if (match?.[1]) skills.add(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
