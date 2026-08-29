import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { repairTruncatedTrailingLine } from "../../src/utils/file-lines.js";

describe("repairTruncatedTrailingLine", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createFile(name: string, content: string): string {
		const root = mkdtempSync(join(tmpdir(), "prime-torn-tail-"));
		roots.push(root);
		const path = join(root, name);
		writeFileSync(path, content);
		return path;
	}

	it("is a no-op for missing, empty, and newline-terminated files", () => {
		const missing = join(tmpdir(), "prime-torn-missing", "absent.jsonl");
		expect(() => repairTruncatedTrailingLine(missing)).not.toThrow();

		const empty = createFile("empty.jsonl", "");
		repairTruncatedTrailingLine(empty);
		expect(readFileSync(empty, "utf8")).toBe("");

		const clean = createFile("clean.jsonl", '{"a":1}\n{"b":2}\n');
		repairTruncatedTrailingLine(clean);
		expect(readFileSync(clean, "utf8")).toBe('{"a":1}\n{"b":2}\n');
	});

	it("drops a torn trailing line and keeps every terminated line", () => {
		const path = createFile("torn.jsonl", '{"a":1}\n{"b":2}\n{"c":3,"torn":');
		repairTruncatedTrailingLine(path);
		expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
	});

	it("empties a file that is one torn line only", () => {
		const path = createFile("only-torn.jsonl", '{"never":"terminated"');
		repairTruncatedTrailingLine(path);
		expect(readFileSync(path, "utf8")).toBe("");
	});
});

describe("session transcripts with a torn tail", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs the torn tail on open so the next append does not glue onto it", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-torn-session-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		const sessionId = "01torn-session-test";
		const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
		const header = {
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: root,
		};
		const goodEntry = {
			type: "session_info",
			id: "info-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			name: "kept",
		};
		const torn = '{"type":"session_info","id":"info-torn","nam';
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(sessionFile, [JSON.stringify(header), JSON.stringify(goodEntry)].join("\n") + `\n${torn}`);

		const manager = SessionManager.open(sessionFile, sessionDir);
		manager.appendSessionInfo("after-repair");
		manager.flushNow();

		// Every surviving line parses; the good lines and the new entry are all
		// present; the torn bytes are gone and glued nothing to themselves.
		const lines = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		const parsed = lines.map((line) => JSON.parse(line) as { id?: string; name?: string });
		expect(parsed.some((entry) => entry.id === "info-1" && entry.name === "kept")).toBe(true);
		expect(parsed.some((entry) => entry.name === "after-repair")).toBe(true);
		expect(lines.some((line) => line.includes("info-torn"))).toBe(false);
		expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
	});
});
