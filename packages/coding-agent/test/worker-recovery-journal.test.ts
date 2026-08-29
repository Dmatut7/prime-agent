import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";

describe("WorkerRecoveryJournal", () => {
	const roots: string[] = [];

	it("drops a torn trailing line so the next append does not glue onto it", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "prompt_accepted",
		});
		// Simulate a crash mid-append of the next record.
		appendFileSync(path, '{"version":1,"activeSessionId":"active-2","torn');

		const reopened = new WorkerRecoveryJournal(path);
		reopened.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "prompt_complete",
		});

		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(lines.some((line) => line.includes("active-2"))).toBe(true);
		expect(
			reopened
				.getLatest()
				.map((record) => record.activeSessionId)
				.sort(),
		).toEqual(["active-1", "active-2"]);
	});

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-worker-recovery-"));
		roots.push(root);
		return join(root, "worker.recovery.jsonl");
	}

	it("restores the latest operation state per session", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			busy: true,
			operation: "prompt_accepted",
		});
		journal.record({
			activeSessionId: "active-2",
			sessionId: "session-2",
			busy: false,
			operation: "ready",
		});

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeSessionId: "active-1", busy: true, operation: "prompt_accepted" }),
				expect.objectContaining({ activeSessionId: "active-2", busy: false, operation: "ready" }),
			]),
		);
	});

	it("compacts stable checkpoints and ignores a truncated final record", () => {
		const path = createPath();
		const journal = new WorkerRecoveryJournal(path);
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: true,
			operation: "bash_start",
		});
		journal.record({
			activeSessionId: "active-1",
			sessionId: "session-1",
			busy: false,
			operation: "bash_end",
		});
		appendFileSync(path, "{truncated");

		expect(WorkerRecoveryJournal.readLatest(path)).toEqual([
			expect.objectContaining({ activeSessionId: "active-1", busy: false, operation: "bash_end" }),
		]);
	});
});
