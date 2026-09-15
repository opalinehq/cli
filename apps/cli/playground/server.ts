import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { getBuildProductAnalyticsConfig } from "../src/lib/product-analytics-config.js";
import {
	parseUploadManagerTheme,
	type UploadManagerTheme,
} from "../src/lib/upload-manager-theme.js";
import { createPreview } from "./model.js";

const themeFile = new URL(
	"../src/lib/upload-manager-theme.json",
	import.meta.url,
);
const clientBuild = await Bun.build({
	entrypoints: [new URL("./client.ts", import.meta.url).pathname],
	target: "browser",
});
if (!clientBuild.success || !clientBuild.outputs[0])
	throw new Error("Could not build the playground client.");
const client = clientBuild.outputs[0];
const staticFiles = new Map([
	["/", new URL("./index.html", import.meta.url)],
	["/playground.css", new URL("./playground.css", import.meta.url)],
]);
let applying = false;
const requestedPort = Number(process.argv[2] ?? 4077);
if (
	!Number.isInteger(requestedPort) ||
	requestedPort < 1024 ||
	requestedPort > 65535
)
	throw new Error("Pass a port between 1024 and 65535.");

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: requestedPort,
	maxRequestBodySize: 32 * 1024,
	async fetch(request) {
		const url = new URL(request.url);
		if (
			!["127.0.0.1", "localhost"].includes(url.hostname) ||
			url.port !== String(requestedPort)
		)
			return new Response("Invalid host", { status: 403 });
		try {
			if (request.method === "GET") {
				if (url.pathname === "/client.js")
					return new Response(client, {
						headers: { "Content-Type": "text/javascript" },
					});
				if (url.pathname === "/api/theme")
					return Response.json(
						parseUploadManagerTheme(await Bun.file(themeFile).json()),
						{ headers: { "Cache-Control": "no-store" } },
					);
				const file = staticFiles.get(url.pathname);
				if (file)
					return new Response(Bun.file(file), {
						headers: { "Cache-Control": "no-store" },
					});
			}
			if (request.method === "POST") {
				// Only the local playground page can request source-file changes.
				if (
					request.headers.get("origin") !== url.origin ||
					!request.headers.get("content-type")?.startsWith("application/json")
				)
					return new Response("Open this action from the local playground.", {
						status: 403,
					});
				if (url.pathname === "/api/preview")
					return Response.json(createPreview(await request.json()));
				if (url.pathname === "/api/apply") {
					const theme = parseUploadManagerTheme(await request.json());
					if (applying)
						return new Response("A save is already running.", { status: 409 });
					applying = true;
					try {
						await applyTheme(theme);
						return Response.json({
							theme,
							message: "Applied to your local CLI.",
						});
					} finally {
						applying = false;
					}
				}
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : "Request failed." },
				{ status: 400 },
			);
		}
	},
});
console.log(`\n  Opaline CLI playground → ${server.url}\n`);

async function applyTheme(theme: UploadManagerTheme) {
	const previous = await Bun.file(themeFile).text();
	const temporary = new URL(
		`./.upload-manager-theme-${crypto.randomUUID()}.json`,
		themeFile,
	);
	const temporaryFiles: URL[] = [];
	let written = false;
	try {
		await Bun.write(temporary, `${JSON.stringify(theme, null, "\t")}\n`);
		await rename(temporary, themeFile);
		written = true;
		const artifacts: Array<{ temporary: URL; destination: URL }> = [];
		for (const [entrypoint, filename] of [
			["../src/bin/cli.ts", "cli.js"],
			["../src/run-cli.ts", "run-cli.js"],
		] as const) {
			const build = await Bun.build({
				entrypoints: [new URL(entrypoint, import.meta.url).pathname],
				target: "node",
				define: {
					OPALINE_BUNDLED_ANALYTICS: JSON.stringify(
						getBuildProductAnalyticsConfig(process.env),
					),
				},
			});
			if (!build.success || !build.outputs[0])
				throw new Error("Could not build the CLI.");
			await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
			const temporary = new URL(
				`../dist/.playground-${crypto.randomUUID()}.js`,
				import.meta.url,
			);
			temporaryFiles.push(temporary);
			await Bun.write(temporary, build.outputs[0]);
			await chmod(temporary, 0o755);
			artifacts.push({
				temporary,
				destination: new URL(`../dist/${filename}`, import.meta.url),
			});
		}
		for (const artifact of artifacts)
			await rename(artifact.temporary, artifact.destination);
	} catch (error) {
		if (written) {
			await Bun.write(temporary, previous);
			await rename(temporary, themeFile);
		}
		throw error;
	} finally {
		await Promise.allSettled([
			unlink(temporary),
			...temporaryFiles.map((file) => unlink(file)),
		]);
	}
}
