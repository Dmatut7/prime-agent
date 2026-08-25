import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { DaemonCommand, DaemonResponse, DaemonServerCapability } from "../src/modes/daemon/daemon-protocol.js";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * A subagent token burst schedules a summary refresh, and a full list response
 * carries every row's in-flight assistant message. Those grow for the whole
 * turn, so at streaming cadence the refresh alone moves megabytes per second
 * through the worker socket for fields that only counters are read from.
 */

const ROOT = "active-root";

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: ROOT,
		activeSessionId: ROOT,
		lifecycle: "live",
		activity: "working",
		isSessionActive: true,
		sessionId: "session-root",
		sessionFile: "/tmp/root.jsonl",
		cwd: "/tmp/project",
		isStreaming: true,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	} as SessionSummary;
}

function createHarness(options: {
	capabilities?: readonly DaemonServerCapability[];
	rows: SessionSummary[];
	cached?: Map<string, SessionSummary>;
}) {
	const capabilities = options.capabilities ?? ["list_without_streaming_messages"];
	const requests: DaemonCommand[] = [];
	const worker = {
		descriptor: { workerId: "worker-1", rootActiveSessionId: ROOT, createCommand: { type: "create" } },
		summaries: options.cached ?? new Map<string, SessionSummary>(),
		client: {
			supports: (capability: DaemonServerCapability) => capabilities.includes(capability),
			request: (command: DaemonCommand) => {
				requests.push(command);
				const rows =
					command.type === "list" && command.omitStreamingMessages ? stripped(options.rows) : options.rows;
				return Promise.resolve(success(undefined, "list", { sessions: rows }));
			},
		},
	};
	const seed = vi.fn();
	const clear = vi.fn();
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		streamReconstructor: { seed, clear },
		isWorkerStopping: () => false,
		persistWorker: vi.fn(),
		assertRecoveryAllowed: async () => {},
	}) as {
		refreshWorkerSummaries(
			worker: unknown,
			options?: { recovery?: boolean; omitStreamingMessages?: boolean },
		): Promise<void>;
	};
	return { requests, seed, clear, supervisor, worker };
}

function stripped(rows: SessionSummary[]): SessionSummary[] {
	return rows.map((row) => {
		const { streamingMessage: _streamingMessage, ...rest } = row;
		return rest as SessionSummary;
	});
}

describe("streaming-driven summary refresh", () => {
	it("asks the worker to leave in-flight messages out and keeps the row it already held", async () => {
		const held = assistant("first half");
		const { requests, seed, supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: assistant("first half plus more") })],
			cached: new Map([[ROOT, summary({ streamingMessage: held })]]),
		});

		await supervisor.refreshWorkerSummaries(worker, { omitStreamingMessages: true });

		expect(requests).toEqual([{ type: "list", omitStreamingMessages: true }]);
		// Nothing may observe the field disappearing, so the held message stands
		// until a pass that carries authoritative content replaces it.
		expect(worker.summaries.get(ROOT)?.streamingMessage).toBe(held);
		// Re-seeding is drift correction against the worker's authoritative copy;
		// a response without one must not overwrite the reconstructor.
		expect(seed).not.toHaveBeenCalled();
	});

	it("sends a plain list when the worker does not advertise the capability", async () => {
		const inFlight = assistant("in flight");
		const { requests, seed, supervisor, worker } = createHarness({
			capabilities: [],
			rows: [summary({ streamingMessage: inFlight })],
		});

		await supervisor.refreshWorkerSummaries(worker, { omitStreamingMessages: true });

		expect(requests).toEqual([{ type: "list" }]);
		expect(worker.summaries.get(ROOT)?.streamingMessage).toBe(inFlight);
		expect(seed).toHaveBeenCalledWith(ROOT, inFlight);
	});

	it("keeps roster-level refreshes on the full response", async () => {
		const inFlight = assistant("in flight");
		const { requests, seed, supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: inFlight })],
		});

		await supervisor.refreshWorkerSummaries(worker);

		expect(requests).toEqual([{ type: "list" }]);
		expect(seed).toHaveBeenCalledWith(ROOT, inFlight);
	});

	it("carries a row with no cached message through untouched", async () => {
		const { supervisor, worker } = createHarness({
			rows: [summary({ streamingMessage: assistant("in flight") })],
		});

		await supervisor.refreshWorkerSummaries(worker, { omitStreamingMessages: true });

		expect(worker.summaries.get(ROOT)?.streamingMessage).toBeUndefined();
		expect(worker.summaries.get(ROOT)?.messageCount).toBe(3);
	});

	it("still retires the reconstructor when a row stops streaming", async () => {
		const { clear, supervisor, worker } = createHarness({
			rows: [summary({ isStreaming: false, activity: "idle" })],
			cached: new Map([[ROOT, summary({ streamingMessage: assistant("stale") })]]),
		});

		await supervisor.refreshWorkerSummaries(worker, { omitStreamingMessages: true });

		expect(clear).toHaveBeenCalledWith(ROOT);
	});
});

describe("client-driven list that omits in-flight messages", () => {
	function createListHarness(rows: SessionSummary[], cached: Map<string, SessionSummary>) {
		const requests: DaemonCommand[] = [];
		const worker = {
			descriptor: { workerId: "worker-1", rootActiveSessionId: ROOT, createCommand: { type: "create" }, pid: 7 },
			summaries: cached,
			client: {
				supports: () => true,
				request: (command: DaemonCommand) => {
					requests.push(command);
					const sessions = command.type === "list" && command.omitStreamingMessages ? stripped(rows) : rows;
					return Promise.resolve(success(undefined, "list", { sessions }));
				},
			},
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set(),
			streamReconstructor: { seed: vi.fn(), clear: vi.fn() },
			isWorkerStopping: () => false,
			isVisibleWorker: () => true,
			persistWorker: vi.fn(),
			assertRecoveryAllowed: async () => {},
			syncAgentPeers: async () => {},
			log: vi.fn(),
		}) as {
			handleList(client: unknown, command: Extract<DaemonCommand, { type: "list" }>): Promise<DaemonResponse>;
		};
		return { requests, supervisor, worker };
	}

	function listedRows(response: DaemonResponse): SessionSummary[] {
		if (!response.success) throw new Error(response.error);
		return (response.data as { sessions: SessionSummary[] }).sessions;
	}

	it("passes the request through to the worker and answers without the messages", async () => {
		const { requests, supervisor } = createListHarness(
			[summary({ streamingMessage: assistant("in flight") })],
			// A message this supervisor still holds from an earlier pass must not
			// ride along on a response that asked for rows without one.
			new Map([[ROOT, summary({ streamingMessage: assistant("held") })]]),
		);

		const response = await supervisor.handleList({}, { type: "list", omitStreamingMessages: true });

		expect(requests).toEqual([{ type: "list", omitStreamingMessages: true }]);
		expect(listedRows(response)[0]?.streamingMessage).toBeUndefined();
	});

	it("keeps answering a plain list with the full rows", async () => {
		const inFlight = assistant("in flight");
		const { requests, supervisor } = createListHarness([summary({ streamingMessage: inFlight })], new Map());

		const response = await supervisor.handleList({}, { type: "list" });

		expect(requests).toEqual([{ type: "list" }]);
		expect(listedRows(response)[0]?.streamingMessage).toEqual(inFlight);
	});
});
