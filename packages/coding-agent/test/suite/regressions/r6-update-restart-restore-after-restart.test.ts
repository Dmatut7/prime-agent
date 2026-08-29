/**
 * R6 regression: the prepared update-restart checkpoint used to live only in the
 * supervisor's memory. If the supervisor died after a successful prepare but
 * before the handoff completed, the replacement process started with no phase and
 * no checkpoint: the intentionally stopped workers looked like crashed workers
 * (their stop was not persisted), recovery resurrected them, and the next prepare
 * re-prepared from the resurrected state instead of re-issuing the checkpoint.
 *
 * The fix (a) removes the stopped workers' descriptors, persisting stop tombstones
 * so they are not resurrected, and (b) re-enters the prepared phase on startup
 * when a fresh checkpoint is on disk and no worker descriptors survived, so a
 * retried prepare re-issues the checkpoint.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../../../src/config.js";
import { DaemonCatalogClient } from "../../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

describe("R6 prepared update restart survives a supervisor restart", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const roots: string[] = [];
	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("re-enters the prepared phase from a fresh on-disk checkpoint on startup", async () => {
		const root = mkdtempSync(`/tmp/prime-r6-update-restart-${process.pid}-`);
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");

		// A checkpoint persisted by the previous (now dead) supervisor, with one
		// session awaiting restore.
		const manifestPath = getDaemonUpdateRestartManifestPath(socketPath, root);
		mkdirSync(join(root, "daemon-update-restarts"), { recursive: true });
		writeFileSync(
			manifestPath,
			`${JSON.stringify({
				formatVersion: 1,
				createdAt: new Date().toISOString(),
				sessions: [
					{
						activeSessionId: "active-1",
						sessionId: "session-1",
						sessionFile: join(root, "session-1.jsonl"),
						cwd: root,
						config: {},
						queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
						shouldResume: false,
						wasStreaming: false,
						wasCompacting: false,
						wasBashRunning: false,
						hadRunningRlmChildren: false,
						wasRetrying: false,
						hadAcceptedPromptInFlight: false,
					},
				],
			})}\n`,
		);

		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir: join(root, "workers"),
		});
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		await supervisor.start();
		const client = new DaemonClient(socketPath);
		await client.connect();
		cleanups.push(async () => {
			client.close();
			await Reflect.apply(Reflect.get(supervisor, "cleanupSupervisorResources"), supervisor, []);
		});

		// The replacement supervisor is back in the prepared phase, so a retried
		// prepare re-issues the checkpoint instead of re-preparing from scratch.
		const prepare = await client.request({ type: "prepare_update_restart" });
		expect(prepare).toMatchObject({
			success: true,
			data: { formatVersion: 1, sessions: [{ activeSessionId: "active-1" }] },
		});
	});
});
