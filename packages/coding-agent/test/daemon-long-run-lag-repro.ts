/**
 * Reproduce long-run daemon lag on cloud: many resident workers + Agents View polling.
 *
 * Run from packages/coding-agent:
 *   PRIME_AGENT_STRESS_WORKERS=44 npx tsx test/daemon-long-run-lag-repro.ts
 *   PRIME_AGENT_STRESS_WORKERS=44 POLL_SECONDS=45 npx tsx test/daemon-long-run-lag-repro.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/core/session-manager.js";
import { createAgentsViewListCommand } from "../src/modes/agents-view/agents-view-mode.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

const cliPath = resolve(import.meta.dirname, "../src/cli.ts");
const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
const WORKER_COUNT = Number.parseInt(process.env.PRIME_AGENT_STRESS_WORKERS ?? "44", 10);
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS ?? "60", 10);
const MESSAGES_PER_SESSION = Number.parseInt(process.env.MESSAGES_PER_SESSION ?? "0", 10);
const MESSAGE_CHARS = Number.parseInt(process.env.MESSAGE_CHARS ?? "1024", 10);
const SUBAGENTS_PER_ROOT = Number.parseInt(process.env.SUBAGENTS_PER_ROOT ?? "0", 10);
const SUBAGENT_MESSAGES = Number.parseInt(process.env.SUBAGENT_MESSAGES ?? "800", 10);
const POLL_INTERVAL_MS = 1000;

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	return spawn(process.execPath, [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"], {
		cwd,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			TSX_TSCONFIG_PATH: resolve(import.meta.dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function connectEventually(socketPath: string, supervisor: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (supervisor.exitCode !== null || supervisor.signalCode !== null) {
			throw new Error(`Supervisor exited early: code=${supervisor.exitCode} signal=${supervisor.signalCode}`);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	throw new Error(`Timed out connecting: ${String(lastError)}`);
}

function readRssKb(pid: number): number | undefined {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const match = status.match(/^VmRSS:\s+(\d+)/m);
		return match ? Number.parseInt(match[1]!, 10) : undefined;
	} catch {
		return undefined;
	}
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index]!;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "prime-lag-repro-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(agentDir, "sessions");
	const socketPath = join(tmpdir(), `prime-lag-repro-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
	mkdirSync(projectDir, { recursive: true });

	console.log(
		`workers=${WORKER_COUNT} poll_seconds=${POLL_SECONDS} messages_per_session=${MESSAGES_PER_SESSION} subagents_per_root=${SUBAGENTS_PER_ROOT}`,
	);

	const sessionFiles: string[] = [];
	for (let index = 0; index < WORKER_COUNT; index++) {
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: `lag repro root ${index}`, timestamp: index + 1 });
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("fixture session missing");
		if (MESSAGES_PER_SESSION > 0) {
			const chunk = "x".repeat(MESSAGE_CHARS);
			for (let messageIndex = 0; messageIndex < MESSAGES_PER_SESSION; messageIndex++) {
				appendFileSync(
					sessionFile,
					`${JSON.stringify({
						type: "message",
						id: `bulk-${index}-${messageIndex}`,
						parentId: null,
						message: {
							role: messageIndex % 2 === 0 ? "user" : "assistant",
							content: [{ type: "text", text: `${chunk}-${messageIndex}` }],
							timestamp: 10_000 + messageIndex,
						},
					})}\n`,
				);
			}
		}
		sessionFiles.push(sessionFile);
	}

	if (SUBAGENTS_PER_ROOT > 0) {
		const ledger = new RlmSpawnLedger(agentDir, sessionDir);
		for (let rootIndex = 0; rootIndex < WORKER_COUNT; rootIndex++) {
			const parent = sessionFiles[rootIndex]!;
			for (let childIndex = 0; childIndex < SUBAGENTS_PER_ROOT; childIndex++) {
				const childManager = SessionManager.create(projectDir, sessionDir);
				childManager.appendMessage({
					role: "user",
					content: `passive child ${rootIndex}-${childIndex}`,
					timestamp: 1,
				});
				const childFile = childManager.getSessionFile();
				if (!childFile) throw new Error("child session missing");
				const chunk = "y".repeat(MESSAGE_CHARS);
				for (let messageIndex = 0; messageIndex < SUBAGENT_MESSAGES; messageIndex++) {
					appendFileSync(
						childFile,
						`${JSON.stringify({
							type: "message",
							id: `child-bulk-${rootIndex}-${childIndex}-${messageIndex}`,
							parentId: null,
							message: {
								role: messageIndex % 2 === 0 ? "user" : "assistant",
								content: [{ type: "text", text: `${chunk}-${messageIndex}` }],
								timestamp: 20_000 + messageIndex,
							},
						})}\n`,
					);
				}
				await ledger.appendSpawn({
					childId: `child-${rootIndex}-${childIndex}`,
					parent,
					child: childFile,
					depth: 1,
					name: `sub-${rootIndex}-${childIndex}`,
				});
			}
		}
	}

	const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
	const client = await connectEventually(socketPath, supervisor);

	const createStarted = performance.now();
	for (const sessionPath of sessionFiles) {
		const response = await client.request({
			type: "create",
			sessionPath,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!response.success) throw new Error(`create failed: ${response.error}`);
	}
	const createMs = performance.now() - createStarted;

	const listed = await client.request({ type: "list" });
	if (!listed.success) throw new Error(listed.error);
	const sessionCount = (listed.data as { sessions: unknown[] }).sessions.length;
	const workerPidsFromList = new Set(
		(listed.data as { sessions: Array<{ workerPid?: number }> }).sessions
			.map((s) => s.workerPid)
			.filter((pid): pid is number => typeof pid === "number"),
	);
	let workerRssKb = 0;
	for (const pid of workerPidsFromList) {
		workerRssKb += readRssKb(pid) ?? 0;
	}
	const supervisorRssKb = supervisor.pid ? (readRssKb(supervisor.pid) ?? 0) : 0;
	console.log(
		`created ${sessionCount} sessions in ${createMs.toFixed(0)}ms | supervisor RSS ${(supervisorRssKb / 1024).toFixed(0)}MB | workers RSS ${(workerRssKb / 1024).toFixed(0)}MB (avg ${(workerRssKb / 1024 / Math.max(1, workerPidsFromList.size)).toFixed(0)}MB)`,
	);

	const listCommand = createAgentsViewListCommand(client);
	const latencies: number[] = [];
	const rssSamples: Array<{ t: number; supervisorRssMb: number; workerRssMb: number }> = [];
	const workerPids = new Set<number>();

	const pollDeadline = Date.now() + POLL_SECONDS * 1000;
	let pollIndex = 0;
	while (Date.now() < pollDeadline) {
		const started = performance.now();
		const response = await client.request(listCommand);
		const elapsed = performance.now() - started;
		if (!response.success) throw new Error(`poll ${pollIndex} failed: ${response.error}`);
		latencies.push(elapsed);
		pollIndex++;

		if (supervisor.pid) {
			let workerRss = 0;
			for (const pid of workerPids) {
				workerRss += readRssKb(pid) ?? 0;
			}
			const supervisorRss = readRssKb(supervisor.pid) ?? 0;
			rssSamples.push({
				t: pollIndex,
				supervisorRssMb: supervisorRss / 1024,
				workerRssMb: workerRss / 1024,
			});
		}

		const wait = POLL_INTERVAL_MS - (performance.now() - started);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}

	// Collect worker pids once from list for RSS (after poll loop to avoid extra work during measure)
	const finalList = await client.request({ type: "list" });
	if (finalList.success) {
		for (const summary of (finalList.data as { sessions: Array<{ workerPid?: number }> }).sessions) {
			if (summary.workerPid) workerPids.add(summary.workerPid);
		}
	}

	const first5 = latencies.slice(0, 5);
	const last5 = latencies.slice(-5);
	const first5Avg = first5.reduce((a, b) => a + b, 0) / Math.max(1, first5.length);
	const last5Avg = last5.reduce((a, b) => a + b, 0) / Math.max(1, last5.length);
	const ratio = last5Avg / Math.max(1, first5Avg);

	console.log("\n=== Agents View poll (list + omitStreamingMessages) ===");
	console.log(`polls=${latencies.length}`);
	console.log(
		`list p50=${percentile(latencies, 50).toFixed(0)}ms p95=${percentile(latencies, 95).toFixed(0)}ms max=${Math.max(...latencies).toFixed(0)}ms`,
	);
	console.log(
		`first5_avg=${first5Avg.toFixed(0)}ms last5_avg=${last5Avg.toFixed(0)}ms slowdown_ratio=${ratio.toFixed(2)}x`,
	);

	if (rssSamples.length >= 2) {
		const first = rssSamples[0]!;
		const last = rssSamples.at(-1)!;
		console.log(`supervisor RSS ${first.supervisorRssMb.toFixed(0)}MB -> ${last.supervisorRssMb.toFixed(0)}MB`);
	}

	// Compare full streaming list (no omit) for one shot
	const fullStarted = performance.now();
	const full = await client.request({ type: "list" });
	const fullMs = performance.now() - fullStarted;
	const omitStarted = performance.now();
	const omit = await client.request(listCommand);
	const omitMs = performance.now() - omitStarted;
	console.log("\n=== Single list request cost ===");
	console.log(`full list=${fullMs.toFixed(0)}ms omitStreaming=${omitMs.toFixed(0)}ms (${sessionCount} sessions)`);
	if (!full.success || !omit.success) throw new Error("final list failed");

	await client.request({ type: "shutdown" });
	client.close();
	supervisor.kill("SIGTERM");

	console.log("\n=== Verdict ===");
	if (ratio >= 1.5 || percentile(latencies, 95) >= 3000) {
		console.log("REPRODUCED: Agents View polling degrades or stays very slow at this load.");
	} else if (percentile(latencies, 50) >= 500 || fullMs >= 5000) {
		console.log("REPRODUCED: each poll is already expensive (matches long-run lag baseline).");
	} else {
		console.log(
			"This load profile did not reproduce strong lag; try higher MESSAGES_PER_SESSION or SUBAGENTS_PER_ROOT.",
		);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
