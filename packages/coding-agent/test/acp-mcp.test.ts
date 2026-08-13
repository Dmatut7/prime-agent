import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { AcpMcpSkillInstaller } from "../src/modes/acp/acp-mcp.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./suite/harness.js";

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.close();
		await once(server, "close");
	}
});

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

async function startHttpMcpServer(): Promise<{ url: string; authorization: () => string | undefined }> {
	let authorization: string | undefined;
	const server = createServer(async (request, response) => {
		authorization = request.headers.authorization;
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const message = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
			id?: string | number;
			method: string;
			params?: { protocolVersion?: string };
		};
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		const result =
			message.method === "initialize"
				? {
						protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "test-tools", version: "1.0.0" },
					}
				: {
						tools: [
							{
								name: "lookup",
								description: "Look up a task by query.",
								inputSchema: {
									type: "object",
									properties: { query: { type: "string" }, limit: { type: "integer" } },
									required: ["query"],
								},
							},
						],
					};
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test MCP server did not bind TCP");
	return { url: `http://127.0.0.1:${address.port}/mcp`, authorization: () => authorization };
}

describe("ACP MCP servers", () => {
	it("advertises HTTP support and configures session/new servers", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const agentCwd = (await connection.getState()).cwd;
		const configureMcpServers = vi.fn();
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			configureMcpServers,
		});
		const handle = acp
			.client({ name: "mcp-test-client" })
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		try {
			const initialized = await handle.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);

			const server: acp.McpServer = {
				type: "http",
				name: "task-tools",
				url: "http://127.0.0.1:8000/mcp",
				headers: [{ name: "Authorization", value: "Bearer task" }],
			};
			await handle.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [server] });
			expect(configureMcpServers).toHaveBeenCalledWith([server], agentCwd);
		} finally {
			handle.close();
			await toAgent.writable.close().catch(() => undefined);
			await modeDone;
			harness.cleanup();
		}
	}, 30_000);

	it("discovers HTTP tools and writes one callable Python program per tool", async () => {
		const mcp = await startHttpMcpServer();
		const replaceTemporarySkills = vi.fn();
		const installer = new AcpMcpSkillInstaller({ replaceTemporarySkills });
		try {
			await installer.configure(
				[
					{
						type: "http",
						name: "task-tools",
						url: mcp.url,
						headers: [{ name: "Authorization", value: "Bearer task" }],
					},
				],
				process.cwd(),
			);

			expect(mcp.authorization()).toBe("Bearer task");
			expect(replaceTemporarySkills).toHaveBeenCalledOnce();
			const [skillPaths] = replaceTemporarySkills.mock.calls[0] as [string[], string];
			expect(skillPaths).toHaveLength(1);
			const skillDir = dirname(skillPaths[0]);
			expect(basename(skillDir)).toBe("task-tools-lookup");
			expect(readFileSync(skillPaths[0], "utf-8")).toContain("await task_tools_lookup(...)");
			const source = readFileSync(join(skillDir, "src", "task_tools_lookup", "__init__.py"), "utf-8");
			expect(source).toContain("make_acp_mcp_skill");
			expect(source).toContain("Look up a task by query.");
		} finally {
			installer.dispose();
		}
	});

	it("replaces the previous ACP session's generated programs", async () => {
		const resourceRoot = mkdtempSync(join(tmpdir(), "prime-agent-acp-mcp-replace-test-"));
		const resourceLoader = new DefaultResourceLoader({
			cwd: resourceRoot,
			agentDir: resourceRoot,
			bundledSkillsDir: null,
		});
		await resourceLoader.reload();
		const harness = await createHarness({ resourceLoader });
		const installer = new AcpMcpSkillInstaller(harness.session, async (server) => [
			{ name: "lookup", description: `Look up data from ${server}.`, inputSchema: { type: "object" } },
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		try {
			await installer.configure(
				[{ type: "http", name: "first", url: "https://first.test/mcp", headers: [] }],
				harness.tempDir,
			);
			expect((await connection.getResourceSnapshot()).skills.map((skill) => skill.name)).toContain("first-lookup");

			await installer.configure(
				[{ type: "http", name: "second", url: "https://second.test/mcp", headers: [] }],
				harness.tempDir,
			);
			const replaced = (await connection.getResourceSnapshot()).skills.map((skill) => skill.name);
			expect(replaced).not.toContain("first-lookup");
			expect(replaced).toContain("second-lookup");
		} finally {
			installer.dispose();
			await connection.dispose();
			harness.cleanup();
			rmSync(resourceRoot, { recursive: true, force: true });
		}
	});
});
