/**
 * Quantify per-list-poll overhead in the supervisor: descriptor write churn,
 * agent-peer fan-out cost, CPU per poll, and worker RSS drift over a soak.
 *
 * Workers are idle with tiny sessions, so every byte written and every
 * millisecond burned during the soak is pure per-poll overhead.
 *
 *   cd packages/coding-agent
 *   WORKERS=32 POLL_SECONDS=60 npx tsx test/daemon-list-churn-diagnostic.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/core/session-manager.js";
import { createAgentsViewListCommand } from "../src/modes/agents-view/agents-view-mode.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const cliPath = resolve(import.meta.dirname, "../src/cli.ts");
const tsxPath = resolve(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");

const WORKERS = Number.parseInt(process.env.WORKERS ?? "32", 10);
const POLL_SECONDS = Number.parseInt(process.env.POLL_SECONDS ?? "60", 10);
const POLL_CLIENTS = Number.parseInt(process.env.POLL_CLIENTS ?? "1", 10);
const LABEL = process.env.LABEL ?? `w${WORKERS}`;

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

function writeBytes(pid: number): number {
	try {
		const m = readFileSync(`/proc/${pid}/io`, "utf8").match(/^write_bytes:\s+(\d+)/m);
		return m ? Number.parseInt(m[1]!, 10) : 0;
	} catch {
		return 0;
	}
}

/** Combined user+system CPU seconds for a pid. */
function cpuSeconds(pid: number): number {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const utime = Number.parseInt(fields[11] ?? "0", 10);
		const stime = Number.parseInt(fields[12] ?? "0", 10);
		return (utime + stime) / 100;
	} catch {
		return 0;
	}
}

function descriptorMtimes(agentDir: string): Map<string, number> {
	const out = new Map<string, number>();
	const base = join(agentDir, "daemon-workers");
	let sockets: string[];
	try {
		sockets = readdirSync(base);
	} catch {
		return out;
	}
	for (const socketKey of sockets) {
		const dir = join(base, socketKey);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			try {
				out.set(`${socketKey}/${name}`, statSync(join(dir, name)).mtimeMs);
			} catch {
				// descriptor replaced mid-scan
			}
		}
	}
	return out;
}

function pct(values: number[], p: number): number {
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "prime-list-churn-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionDir = join(agentDir, "sessions");
	const socketPath = join(tmpdir(), `prime-churn-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
	mkdirSync(projectDir, { recursive: true });

	console.log(`=== LIST CHURN DIAGNOSTIC ${LABEL} ===`);
	console.log(JSON.stringify({ WORKERS, POLL_SECONDS, POLL_CLIENTS }));

	const sessionFiles: string[] = [];
	for (let w = 0; w < WORKERS; w++) {
		const manager = SessionManager.create(projectDir, sessionDir);
		manager.appendMessage({ role: "user", content: `root ${w}`, timestamp: w });
		const file = manager.getSessionFile();
		if (!file) throw new Error("no session file");
		sessionFiles.push(file);
	}

	const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
	const supervisorPid = supervisor.pid;
	if (!supervisorPid) throw new Error("no supervisor pid");
	const primary = await connectClient(socketPath);
	for (const sessionPath of sessionFiles) {
		const r = await primary.request({
			type: "create",
			sessionPath,
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		if (!r.success) throw new Error(r.error);
	}

	const listOnce = await primary.request({ type: "list" });
	if (!listOnce.success) throw new Error(listOnce.error);
	const workerPids = [
		...new Set(
			(listOnce.data as { sessions: Array<{ workerPid?: number }> }).sessions
				.map((s) => s.workerPid)
				.filter((p): p is number => typeof p === "number"),
		),
	];
	const sumWorkerRss = () => workerPids.reduce((acc, pid) => acc + rssMb(pid), 0);
	const sumWorkerCpu = () => workerPids.reduce((acc, pid) => acc + cpuSeconds(pid), 0);

	const pollClients = await Promise.all(Array.from({ length: POLL_CLIENTS }, () => connectClient(socketPath)));
	const omitCmd = createAgentsViewListCommand(primary);

	// Let spawn-time work settle so the soak window measures steady state only.
	await new Promise((r) => setTimeout(r, 3000));

	const startWrite = writeBytes(supervisorPid);
	const startCpu = cpuSeconds(supervisorPid);
	const startWorkerCpu = sumWorkerCpu();
	const startRss = sumWorkerRss();
	const startSupRss = rssMb(supervisorPid);
	const startMtimes = descriptorMtimes(agentDir);
	const soakStart = performance.now();

	const latencies: number[] = [];
	let ticks = 0;
	let descriptorRewrites = 0;
	let previousMtimes = startMtimes;
	const deadline = Date.now() + POLL_SECONDS * 1000;
	while (Date.now() < deadline) {
		ticks++;
		const started = performance.now();
		await Promise.all(pollClients.map((c) => c.request(omitCmd)));
		latencies.push(performance.now() - started);

		const now = descriptorMtimes(agentDir);
		for (const [name, mtime] of now) {
			if (previousMtimes.get(name) !== mtime) descriptorRewrites++;
		}
		previousMtimes = now;

		const wait = 1000 - (performance.now() - started);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	}

	const soakSeconds = (performance.now() - soakStart) / 1000;
	const writeDelta = writeBytes(supervisorPid) - startWrite;
	const cpuDelta = cpuSeconds(supervisorPid) - startCpu;
	const workerCpuDelta = sumWorkerCpu() - startWorkerCpu;
	const endRss = sumWorkerRss();
	const endSupRss = rssMb(supervisorPid);
	const listOps = ticks * POLL_CLIENTS;

	const first = latencies.slice(0, 10);
	const last = latencies.slice(-10);
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

	const summary = {
		label: LABEL,
		workers: workerPids.length,
		pollClients: POLL_CLIENTS,
		ticks,
		soakSeconds: Number(soakSeconds.toFixed(1)),
		listLatencyP50Ms: Number(pct(latencies, 50).toFixed(1)),
		listLatencyP95Ms: Number(pct(latencies, 95).toFixed(1)),
		latencyPerWorkerMs: Number((pct(latencies, 50) / Math.max(1, workerPids.length)).toFixed(3)),
		latencyDriftRatio: Number((avg(last) / Math.max(1, avg(first))).toFixed(2)),
		supervisorWriteKbPerSec: Number((writeDelta / 1024 / soakSeconds).toFixed(1)),
		supervisorWriteKbPerList: Number((writeDelta / 1024 / Math.max(1, listOps)).toFixed(2)),
		descriptorRewrites,
		descriptorRewritesPerList: Number((descriptorRewrites / Math.max(1, listOps)).toFixed(2)),
		supervisorCpuPercent: Number(((cpuDelta / soakSeconds) * 100).toFixed(1)),
		supervisorCpuMsPerList: Number(((cpuDelta * 1000) / Math.max(1, listOps)).toFixed(1)),
		workerCpuPercentTotal: Number(((workerCpuDelta / soakSeconds) * 100).toFixed(1)),
		workerRssStartMb: Number(startRss.toFixed(0)),
		workerRssEndMb: Number(endRss.toFixed(0)),
		workerRssDriftMbPerMin: Number((((endRss - startRss) / soakSeconds) * 60).toFixed(1)),
		supervisorRssStartMb: Number(startSupRss.toFixed(0)),
		supervisorRssEndMb: Number(endSupRss.toFixed(0)),
		supervisorRssDriftMbPerMin: Number((((endSupRss - startSupRss) / soakSeconds) * 60).toFixed(2)),
	};

	console.log("\n=== SUMMARY ===");
	console.log(JSON.stringify(summary, null, 2));
	console.log(`\nSUMMARY_JSON ${JSON.stringify(summary)}`);

	await primary.request({ type: "shutdown" });
	primary.close();
	for (const c of pollClients) c.close();
	supervisor.kill("SIGTERM");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(2);
});
