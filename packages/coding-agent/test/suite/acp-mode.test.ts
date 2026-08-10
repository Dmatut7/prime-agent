import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./harness.js";

/** Minimal AgentSessionRuntime host over a real faux-backed AgentSession. */
function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

/**
 * Drives ACP mode with a REAL @agentclientprotocol/sdk client over an in-memory
 * duplex pair, so the protocol handshake, prompt turn, streamed updates, and
 * stop reason are exercised end to end rather than asserted from source.
 */

interface ClientHarness {
	client: any;
	updates: any[];
	close: () => void;
}

function fakeAcpConnection(
	options: {
		initialSnapshot?: () => Promise<any>;
		finalSnapshot?: () => Promise<any>;
		onInitialSnapshot?: (subscribed: boolean) => void;
		onUnsubscribe?: () => void;
	} = {},
): any {
	let listener: ((event: any) => void) | undefined;
	let subscribed = false;
	const snapshot = { state: { cwd: process.cwd() }, messages: [] };
	return {
		subscribe(callback: (event: any) => void) {
			subscribed = true;
			listener = callback;
			return () => {
				listener = undefined;
				options.onUnsubscribe?.();
			};
		},
		getState: async () => snapshot.state,
		getMessages: async () => [],
		getInitialSnapshot: async () => {
			if (options.onInitialSnapshot) options.onInitialSnapshot(subscribed);
			if (options.initialSnapshot) {
				const result = await options.initialSnapshot();
				options.initialSnapshot = undefined;
				return result;
			}
			if (options.finalSnapshot) return options.finalSnapshot();
			return snapshot;
		},
		promptAndWait: async () => {},
		waitForIdle: async () => {},
		waitForHeadlessCompletion: async () => ({
			enabled: false,
			continuationsUsed: 0,
			turnsUsed: 0,
			tokensUsed: 0,
			limits: { maxContinuations: 0 },
		}),
		emitChild(child: any) {
			listener?.({ type: "session_event", event: { type: "rlm_child_update", child } });
		},
	};
}

/**
 * Real injected work with production timing: after the first headless-completion
 * idle observation, this starts a genuine session turn (a subagent reply has the
 * same shape) and blocks until the session is streaming it. Returns a checker
 * for whether the injection has happened.
 */
function injectWorkAfterHeadlessCompletion(connection: any, session: any, text: string): () => boolean {
	const waitForHeadlessCompletion = connection.waitForHeadlessCompletion.bind(connection);
	let injected = false;
	connection.waitForHeadlessCompletion = async () => {
		const status = await waitForHeadlessCompletion();
		if (!injected) {
			injected = true;
			void session.prompt(text);
			const deadline = Date.now() + 5_000;
			while (!session.isStreaming && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			expect(session.isStreaming).toBe(true);
		}
		return status;
	};
	return () => injected;
}

function connectAcpClient(connection: any): ClientHarness {
	// Two web streams crossed over: agent's stdout is the client's stdin.
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();

	const agentStream = acp.ndJsonStream(toClient.writable, toAgent.readable);
	const clientStream = acp.ndJsonStream(toAgent.writable, toClient.readable);

	const updates: any[] = [];
	void runAcpModeWithConnection(connection, { stream: agentStream } as any);

	const handle = acp
		.client({ name: "test-client" })
		.onNotification("session/update", (ctx: any) => {
			updates.push(ctx.params);
		})
		.connect(clientStream);

	// connect() yields a handle whose `agent` proxy is the outbound call surface.
	return { client: handle.agent, updates, close: () => handle.close() };
}

describe("ACP mode end to end", () => {
	it("completes a prompt turn and streams assistant text", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Hello from prime-agent.")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));

		const { client, updates } = connectAcpClient(connection);

		const init = await client.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
		expect(init.agentInfo?.name).toBe("prime-agent");
		expect(init._meta).toHaveProperty(PRIME_AGENT_META_NAMESPACE);

		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		expect(typeof session.sessionId).toBe("string");

		const result = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Say hello" }],
		});
		expect(result.stopReason).toBe("end_turn");

		const text = updates
			.filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
			.map((u) => u.update.content.text)
			.join("");
		expect(text).toContain("Hello from prime-agent");

		harness.cleanup();
	}, 30_000);

	it("emits score-safe quiescence metadata with outstanding work and budget", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish" }],
		});
		const quiescence = updates.find((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence);
		expect(quiescence?.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence).toEqual({
			outstandingSubagents: 0,
			remainingAutonomousContinuations: 0,
		});
		harness.cleanup();
	}, 30_000);

	it("reports a live in-process child that spawned after ACP attached", async () => {
		const harness = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		let releaseChild!: () => void;
		const childReleased = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		harness.setResponses([
			async () => {
				await childReleased;
				return fauxAssistantMessage("child done");
			},
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		// The child is admitted after ACP attaches, so an attach-time snapshot was
		// empty. Its run stays live while the independent parent prompt completes.
		await harness.session.runRlmChild("continue in the background");
		harness.appendResponses([fauxAssistantMessage("parent done")]);
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish the parent turn" }],
		});
		const quiescence = updates.find((update) => update.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence);
		expect(quiescence?.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence.outstandingSubagents).toBe(1);

		releaseChild();
		await vi.waitFor(() => expect(harness.session.getRlmChildSnapshots()[0]?.status).toBe("done"));
		harness.cleanup();
	}, 30_000);

	it("fails session creation when the initial roster snapshot fails", async () => {
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				throw new Error("snapshot unavailable");
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		close();
	});

	it("releases the subscription when the initial roster snapshot fails", async () => {
		let unsubscribeCount = 0;
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				throw new Error("snapshot unavailable");
			},
			onUnsubscribe: () => {
				unsubscribeCount += 1;
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		expect(unsubscribeCount).toBe(1);
		close();
	});

	it("rejects a concurrent session creation while the first snapshot is pending", async () => {
		let enteredSnapshot!: () => void;
		let releaseSnapshot!: () => void;
		const snapshotEntered = new Promise<void>((resolve) => {
			enteredSnapshot = resolve;
		});
		const snapshotReleased = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const connection = fakeAcpConnection({
			initialSnapshot: async () => {
				enteredSnapshot();
				await snapshotReleased;
				return { state: { cwd: process.cwd() }, messages: [], children: [] };
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const first = client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await snapshotEntered;
		await expect(client.request("session/new", { cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
		releaseSnapshot();
		await expect(first).resolves.toMatchObject({ sessionId: expect.any(String) });
		close();
	});

	it("subscribes before taking the initial roster snapshot", async () => {
		let subscribedAtSnapshot: boolean | undefined;
		const connection = fakeAcpConnection({
			onInitialSnapshot: (subscribed) => {
				subscribedAtSnapshot = subscribed;
			},
		});
		const { client, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		expect(subscribedAtSnapshot).toBe(true);
		close();
	});

	it("propagates a failed roster read at quiescence emission", async () => {
		// A snapshot failure while emitting must not degrade to outstandingSubagents: 0.
		// Reporting a fabricated zero is the false-quiescent answer this metadata
		// exists to prevent: a consumer would score a turn whose children still run.
		const connection = fakeAcpConnection({
			// `initialSnapshot` serves session/new and is then consumed; `finalSnapshot`
			// serves the emission-time read, which is the one under test here.
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => {
				throw new Error("roster unavailable");
			},
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await expect(
			client.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "finish" }],
			}),
		).rejects.toThrow();
		const quiescence = updates.find((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence);
		expect(quiescence).toBeUndefined();
		close();
	});

	it("counts the authoritative live roster at quiescence emission", async () => {
		const child = { id: "child-1", label: "child", status: "running", sessionDir: "/tmp/child" };
		const connection = fakeAcpConnection({
			initialSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [] }),
			finalSnapshot: async () => ({ state: { cwd: process.cwd() }, messages: [], children: [child] }),
		});
		const { client, updates, close } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "finish" }],
		});
		const quiescence = updates.find((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.quiescence);
		expect(quiescence.update._meta[PRIME_AGENT_META_NAMESPACE].quiescence.outstandingSubagents).toBe(1);
		close();
	});
	// Production race: after ACP reported a completed turn, injected work (a
	// subagent reply, heartbeat, goal message) restarted the resident session, so
	// the client's next prompt was rejected with "Agent is already processing".
	// Each regression injects real work after the first idle observation and
	// drives a real ACP client, rather than asserting call ordering.

	it("queues a follow-up prompt behind injected work instead of rejecting it", async () => {
		const harness = await createHarness();
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<any>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			() => injectedHeld,
			fauxAssistantMessage("turn two done"),
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const injected = injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client, updates } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const first = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		expect(first.stopReason).toBe("end_turn");
		expect(injected()).toBe(true);
		// The injected turn is still streaming, so the session is busy when the
		// follow-up prompt arrives, exactly as in the production campaign.
		expect(harness.session.isStreaming).toBe(true);

		let secondSettled = false;
		const second = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "Second turn" }],
			})
			.finally(() => {
				secondSettled = true;
			});
		// The queued turn must neither resolve early nor reject with
		// "Agent is already processing".
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(secondSettled).toBe(false);
		expect(harness.session.isStreaming).toBe(true);
		releaseInjected();
		await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
		expect(harness.session.isStreaming).toBe(false);

		const text = updates
			.filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
			.map((u) => u.update.content.text)
			.join("");
		expect(text).toContain("turn two done");

		harness.cleanup();
	}, 5_000);

	it("reports the queued turn's stop reason from a fresh autonomous status", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxTurns: 2,
				maxContinuations: 3,
				maxTokens: 80_000,
				gates: { commands: ["true"], maxRetries: 3 },
			},
		});
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<any>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([
			fauxAssistantMessage("turn one done"),
			() => injectedHeld,
			fauxAssistantMessage("turn two done"),
		]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		const first = await client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "First turn" }],
		});
		expect(first.stopReason).toBe("end_turn");
		expect(harness.session.getAutonomousStatus().turnsUsed).toBe(1);

		const second = client.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Second turn" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(harness.session.isStreaming).toBe(true);
		releaseInjected();
		// The second prompt's response gates its own queued turn, so the stop
		// reason comes from the status captured after that turn ran, not from a
		// snapshot taken before the injected work consumed the autonomous budget.
		await expect(second).resolves.toMatchObject({ stopReason: "max_turn_requests" });
		expect(harness.session.getAutonomousStatus().turnsUsed).toBeGreaterThanOrEqual(
			harness.session.getAutonomousStatus().limits.maxTurns,
		);
		harness.cleanup();
	}, 5_000);

	it("does not hold the prompt response open for detached work", async () => {
		const harness = await createHarness();
		let releaseInjected!: () => void;
		const injectedHeld = new Promise<any>((resolve) => {
			releaseInjected = () => resolve(fauxAssistantMessage("injected work done"));
		});
		harness.setResponses([fauxAssistantMessage("turn one done"), () => injectedHeld]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const injected = injectWorkAfterHeadlessCompletion(connection, harness.session, "injected work");
		const { client } = connectAcpClient(connection);
		await client.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await client.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		let settled = false;
		const prompt = client
			.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "First turn" }],
			})
			.finally(() => {
				settled = true;
			});
		const deadline = Date.now() + 5_000;
		while (!injected() && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(injected()).toBe(true);
		// The response boundary reports quiescence rather than waiting for it:
		// detached work must not hold the session/prompt response open, which is
		// exactly the quiescence-blocking #806 rejected.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(settled).toBe(true);
		expect(harness.session.isStreaming).toBe(true);
		releaseInjected();
		await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
		harness.cleanup();
	}, 5_000);
});
