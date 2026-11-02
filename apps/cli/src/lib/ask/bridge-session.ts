import type { AskBridgeConnection } from "../../contracts/ask.js";
import type { McpAccess } from "./answer-message.js";

const CONVEX_TOKEN_MARGIN_MS = 2 * 60_000;
const MCP_TOKEN_MARGIN_MS = 15 * 60_000;

export class BridgeSession {
	private refreshing: Promise<AskBridgeConnection> | undefined;

	private constructor(
		private connection: AskBridgeConnection,
		private readonly connect: () => Promise<AskBridgeConnection>,
		private readonly onRefreshError: (error: unknown) => void,
		private readonly now: () => number,
	) {}

	static async open(
		connect: () => Promise<AskBridgeConnection>,
		onRefreshError: (error: unknown) => void,
		now: () => number = Date.now,
	): Promise<BridgeSession> {
		return new BridgeSession(await connect(), connect, onRefreshError, now);
	}

	get current(): AskBridgeConnection {
		return this.connection;
	}

	readonly fetchConvexToken = async ({
		forceRefreshToken,
	}: {
		forceRefreshToken: boolean;
	}): Promise<string | null> => {
		if (
			!forceRefreshToken &&
			!this.expiresWithin("expiresAt", CONVEX_TOKEN_MARGIN_MS)
		)
			return this.connection.token;
		try {
			return (await this.refresh()).token;
		} catch (error) {
			this.onRefreshError(error);
			return this.expiresWithin("expiresAt", 0) ? null : this.connection.token;
		}
	};

	readonly mcpAccess = async (): Promise<McpAccess> => {
		if (this.expiresWithin("mcpTokenExpiresAt", MCP_TOKEN_MARGIN_MS))
			await this.refresh();
		return {
			mcpUrl: this.connection.mcpUrl,
			mcpToken: this.connection.mcpToken,
		};
	};

	private refresh(): Promise<AskBridgeConnection> {
		this.refreshing ??= this.connect()
			.then((connection) => {
				this.connection = connection;
				return connection;
			})
			.finally(() => {
				this.refreshing = undefined;
			});
		return this.refreshing;
	}

	private expiresWithin(
		field: "expiresAt" | "mcpTokenExpiresAt",
		marginMs: number,
	): boolean {
		return this.connection[field] - this.now() < marginMs;
	}
}
