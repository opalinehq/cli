import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getBuildProductAnalyticsConfig } from "./src/lib/product-analytics-config.js";

const analytics = getBuildProductAnalyticsConfig(process.env);
const outdir = join(import.meta.dir, "dist");
await rm(outdir, { recursive: true, force: true });

for (const entrypoint of ["src/bin/cli.ts", "src/run-cli.ts"]) {
	const result = await Bun.build({
		entrypoints: [join(import.meta.dir, entrypoint)],
		outdir,
		target: "node",
		define: { OPALINE_BUNDLED_ANALYTICS: JSON.stringify(analytics) },
	});
	if (!result.success)
		throw new AggregateError(result.logs, "CLI build failed");
}
