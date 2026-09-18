import { buildCommand } from "@stricli/core";
import { offerCliUpdate } from "../lib/cli-update.js";

async function runUpdate(): Promise<undefined | Error> {
	try {
		await offerCliUpdate([], true);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

export const updateCommand = buildCommand({
	loader: async () => ({ default: runUpdate }),
	parameters: {},
	docs: {
		brief: "Review the open-source release and update installed Opaline",
	},
});
