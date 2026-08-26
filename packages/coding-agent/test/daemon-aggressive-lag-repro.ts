/**
 * Aggressive one-shot lag reproduction: memory + poll storm + fat JSONL + subagents.
 *
 *   cd packages/coding-agent
 *   npx tsx test/daemon-aggressive-lag-repro.ts
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
const blockingProcessPath = resolve(import.meta.dirname, "fixtures/blocking-process.mjs");

const WORKERS = Number.parseInt(process.env.WORKERS ?? "44", 10);
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS ?? "120", 10);
const MESSAGES_PER_ROOT = Number.parseInt(process.env.MESSAGES_PER_ROOT ?? "2500", 10);
const MESSAGE_CHARS = Number.parseInt(process.env.MESSAGE_CHARS ?? "2048", 10);
const SUBAGENTS_PER_ROOT = Number.parseInt(process.env.SUBAGENTS_PER_ROOT ?? "8", 10);
const SUBAGENT_MESSAGES = Number.parseInt(process.env.SUBAGENT_MESSAGES ?? "2000", 10);
const POLL_CLIENTS = Number.parseInt(process.env.POLL_CLIENTS ?? "2", 10);

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

async function connectClient(socketPath: string): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(2000);
			return client;
		} catch {
			client.close();
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	throw new Error("connect timeout");
}

function rssMb(pid: number): number {
	try {
		const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m);
		return m ? Number.parseInt(m[1]!, 10) / 1024 : 0;
	} catch {
		return 0;
	}
}

function pct(values: number[], p: number): number {
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

function appendBulkMessages(file: string, count: number, charLen: number, prefix: string): void {
	const chunk = "汉".repeat(Math.max(1, Math.floor(charLen / 3))) + "x".repeat(charLen);
	let batch = "";
	for (let i = 0; i < count; i++) {
		batch += `${JSON.stringify({
			type: "message",
			id: `${prefix}-${i}`,
			parentId: null,
			message: {
				role: i % 2 === 0 ? "user" : "assistant",
				content: [{ type: "text", text: `${chunk}-${i}` }],
				timestamp: 10_000 + i,
			},
		})}\n`;
		if (batch.length > 4_000_000) {
			appendFileSync(file, batch);
			batch = "";
		}
	}
	if (batch) appendFileSync(file, batch);
}

async function main(): Promise<void> {
	const t0 = performance.now();
	const root = mkdtempSync(join(tmpdir(), "prime-aggressive-lag-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(agentDir, "sessions");
	const socketPath = join(tmpdir(), `prime-aggressive-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
	mkdirSync(projectDir, { recursive: true });

	console.log("=== AGGRESSIVE LAG REPRO ===");
	console.log(
		JSON.stringify({ WORKERS, POLL_SECONDS, MESSAGES_PER_ROOT, SUBAGENTS_PER_ROOT, SUBAGENT_MESSAGES, POLL_CLIENTS }),
	);

	// Phase 1: fat sessions + subagent ledger
	const phase1 = performance.now();
	const sessionFiles: string[] = [];
	for (let w = 0; w < WORKERS; w++) {
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: `root ${w}`, timestamp: w });
		const file = manager.getSessionFile();
		if (!file) throw new Error("no session file");
		appendBulkMessages(file, MESSAGES_PER_ROOT, MESSAGE_CHARS, `root-${w}`);
		sessionFiles.push(file);
	}
	const ledger = new RlmSpawnLedger(agentDir, sessionDir);
	for (let w = 0; w < WORKERS; w++) {
		const parent = sessionFiles[w]!;
		for (let c = 0; c < SUBAGENTS_PER_ROOT; c++) {
			const childManager = SessionManager.create(projectDir, sessionDir);
			childManager.appendMessage({ role: "user", content: `child ${w}-${c}`, timestamp: 1 });
			const childFile = childManager.getSessionFile();
			if (!childFile) throw new Error("no child file");
			appendBulkMessages(childFile, SUBAGENT_MESSAGES, MESSAGE_CHARS, `child-${w}-${c}`);
			await ledger.appendSpawn({
				childId: `c-${w}-${c}`,
				parent,
				child: childFile,
				depth: 1,
				name: `sub-${w}-${c}`,
			});
		}
	}
	console.log(`phase1 fixture ${((performance.now() - phase1) / 1000).toFixed(1)}s`);

	// Phase 2: spawn daemon + all workers
	const phase2 = performance.now();
	const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
	const primary = await connectClient(socketPath);
	const summaries = [];
	for (const sessionPath of sessionFiles) {
		const r = await primary.request({
			type: "create",
			sessionPath,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!r.success) throw new Error(r.error);
		summaries.push(r.data as { activeSessionId?: string; id: string; workerPid?: number });
	}
	console.log(`phase2 spawn ${WORKERS} workers ${((performance.now() - phase2) / 1000).toFixed(1)}s`);

	// Pin every worker busy (blocks eviction, like real long-running sessions)
	const phase2b = performance.now();
	await Promise.all(
		summaries.map(async (s, i) => {
			const id = s.activeSessionId ?? s.id;
			const ready = join(root, `block-${i}.ready`);
			const cmd = `${process.execPath} ${blockingProcessPath} ${ready}`;
			const r = await primary.request({ type: "execute_bash", activeSessionId: id, command: cmd });
			if (!r.success) throw new Error(r.error);
		}),
	);
	await Promise.all(
		summaries.map(
			(_, i) =>
				new Promise<void>((resolve, reject) => {
					const deadline = Date.now() + 15_000;
					const tick = () => {
						try {
							if (readFileSync(join(root, `block-${i}.ready`), "utf8")) return resolve();
						} catch {
							// wait
						}
						if (Date.now() > deadline) return reject(new Error(`blocker ${i} timeout`));
						setTimeout(tick, 20);
					};
					tick();
				}),
		),
	);
	console.log(`phase2b pin workers busy ${((performance.now() - phase2b) / 1000).toFixed(1)}s`);

	const listOnce = await primary.request({ type: "list" });
	if (!listOnce.success) throw new Error(listOnce.error);
	const workerPids = new Set(
		(listOnce.data as { sessions: Array<{ workerPid?: number }> }).sessions
			.map((s) => s.workerPid)
			.filter((p): p is number => typeof p === "number"),
	);
	let workerRss = 0;
	for (const pid of workerPids) workerRss += rssMb(pid);
	const supRss = supervisor.pid ? rssMb(supervisor.pid) : 0;
	console.log(
		`MEMORY: supervisor ${supRss.toFixed(0)}MB | ${workerPids.size} workers ${workerRss.toFixed(0)}MB total (avg ${(workerRss / Math.max(1, workerPids.size)).toFixed(0)}MB)`,
	);

	// Phase 3: storm — multiple clients polling like Agents View + legacy full list + heartbeats
	const pollClients = await Promise.all(Array.from({ length: POLL_CLIENTS }, () => connectClient(socketPath)));
	const omitCmd = createAgentsViewListCommand(primary);
	const omitLat: number[] = [];
	const fullLat: number[] = [];
	const hbLat: number[] = [];
	const memSamples: Array<{ t: number; workerRssMb: number; supRssMb: number }> = [];

	const deadline = Date.now() + POLL_SECONDS * 1000;
	let tick = 0;
	console.log(`phase3 poll storm ${POLL_SECONDS}s (${POLL_CLIENTS} clients @ 1Hz + full list + heartbeats)...`);

	while (Date.now() < deadline) {
		tick++;
		const started = performance.now();
		await Promise.all([
			...pollClients.map((c) => c.request(omitCmd)),
			primary.request({ type: "list" }),
			primary.request({ type: "heartbeats_list" }),
		]);
		const elapsed = performance.now() - started;
		omitLat.push(elapsed);
		fullLat.push(elapsed);
		hbLat.push(elapsed);

		let wr = 0;
		for (const pid of workerPids) wr += rssMb(pid);
		memSamples.push({ t: tick, workerRssMb: wr, supRssMb: supervisor.pid ? rssMb(supervisor.pid) : 0 });

		const wait = 1000 - (performance.now() - started);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}

	const first10 = omitLat.slice(0, 10);
	const last10 = omitLat.slice(-10);
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
	const ratio = avg(last10) / Math.max(1, avg(first10));

	console.log("\n=== RESULTS ===");
	console.log(`storm_ticks=${tick}`);
	console.log(
		`combined_poll p50=${pct(omitLat, 50).toFixed(0)}ms p95=${pct(omitLat, 95).toFixed(0)}ms max=${Math.max(...omitLat).toFixed(0)}ms`,
	);
	console.log(
		`first10_avg=${avg(first10).toFixed(0)}ms last10_avg=${avg(last10).toFixed(0)}ms ratio=${ratio.toFixed(2)}x`,
	);
	console.log(
		`memory worker ${memSamples[0]?.workerRssMb.toFixed(0)}MB -> ${memSamples.at(-1)?.workerRssMb.toFixed(0)}MB`,
	);
	console.log(`total_elapsed=${((performance.now() - t0) / 1000).toFixed(0)}s`);

	const lagReproduced = workerRss >= 6000 || pct(omitLat, 95) >= 500 || ratio >= 1.8 || avg(last10) >= 300;

	console.log("\n=== VERDICT ===");
	if (workerRss >= 6000) {
		console.log(
			`REPRODUCED [MEMORY]: ${workerPids.size} workers hold ~${(workerRss / 1024).toFixed(1)}GB RSS — Mac will swap and feel laggy.`,
		);
	}
	if (pct(omitLat, 95) >= 500 || ratio >= 1.8) {
		console.log(
			`REPRODUCED [POLL STORM]: combined daemon refresh p95=${pct(omitLat, 95).toFixed(0)}ms degrading ${ratio.toFixed(2)}x`,
		);
	}
	if (!lagReproduced) {
		console.log("No dramatic lag in this VM window (unlikely on Mac with same worker count + GUI).");
	}

	await primary.request({ type: "shutdown" });
	primary.close();
	for (const c of pollClients) c.close();
	supervisor.kill("SIGTERM");
	process.exit(lagReproduced ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
