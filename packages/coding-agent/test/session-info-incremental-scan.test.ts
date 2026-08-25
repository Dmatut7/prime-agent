import { appendFileSync, copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionInfo, type SessionHeader, type SessionInfo } from "../src/core/session-manager.js";

let dir: string;
let counter = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-incremental-scan-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function headerLine(): string {
	const header: SessionHeader = {
		type: "session",
		id: "session-under-test",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp/project",
	};
	return `${JSON.stringify(header)}\n`;
}

function messageLine(role: "user" | "assistant", text: string, timestamp: number): string {
	return `${JSON.stringify({
		type: "message",
		id: `entry-${++counter}`,
		parentId: null,
		message: { role, content: [{ type: "text", text }], timestamp },
	})}\n`;
}

function namedLine(name: string): string {
	return `${JSON.stringify({ type: "session_info", id: `entry-${++counter}`, parentId: null, name })}\n`;
}

/**
 * A cold read of identical bytes at an untouched path, which never resumes and
 * so reports what a full scan would. Every incremental result is compared
 * against this rather than against hand-written expectations.
 */
async function coldRead(path: string): Promise<SessionInfo | null> {
	const copy = join(dir, `cold-${++counter}.jsonl`);
	copyFileSync(path, copy);
	const info = await readSessionInfo(copy);
	return info ? { ...info, path } : info;
}

async function expectMatchesFullScan(path: string): Promise<SessionInfo | null> {
	const incremental = await readSessionInfo(path);
	expect(incremental).toEqual(await coldRead(path));
	return incremental;
}

describe("readSessionInfo incremental rescan", () => {
	it("reports what a full scan would after each append", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "first question", 1000), "utf8");

		let info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(1);
		expect(info?.firstMessage).toBe("first question");

		appendFileSync(path, messageLine("assistant", "first answer", 2000));
		info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);

		appendFileSync(path, namedLine("renamed session"));
		appendFileSync(path, messageLine("user", "second question", 3000));
		info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(3);
		expect(info?.name).toBe("renamed session");
		expect(info?.firstMessage).toBe("first question");
		expect(info?.modified.getTime()).toBe(3000);
	});

	it("keeps the newest value when a later entry supersedes an earlier one", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + namedLine("original"), "utf8");
		expect((await readSessionInfo(path))?.name).toBe("original");

		appendFileSync(path, namedLine("updated"));
		expect((await expectMatchesFullScan(path))?.name).toBe("updated");
	});

	it("counts a line still being written exactly once", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "complete", 1000), "utf8");
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		// A writer mid-append: the trailing line has no newline yet.
		const pending = messageLine("assistant", "still streaming", 2000);
		const torn = pending.slice(0, pending.length - 5);
		appendFileSync(path, torn);
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		appendFileSync(path, pending.slice(torn.length));
		const info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);
	});

	it("rescans from scratch when the file is replaced rather than appended", async () => {
		const path = join(dir, "session.jsonl");
		writeFileSync(path, headerLine() + messageLine("user", "before rewrite", 1000), "utf8");
		expect((await readSessionInfo(path))?.messageCount).toBe(1);

		// A rewrite renames a fresh inode over the path, and can be longer than
		// what it replaces, so growth alone must not be read as an append.
		const replacement = join(dir, "replacement.jsonl");
		writeFileSync(
			replacement,
			headerLine() + messageLine("user", "after rewrite", 5000) + messageLine("assistant", "reply", 6000),
			"utf8",
		);
		renameSync(replacement, path);

		const info = await expectMatchesFullScan(path);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toBe("after rewrite");
	});

	it("returns null for a file whose first entry is not a session header", async () => {
		const path = join(dir, "headerless.jsonl");
		writeFileSync(path, messageLine("user", "orphan", 1000), "utf8");
		expect(await readSessionInfo(path)).toBeNull();

		appendFileSync(path, messageLine("assistant", "still orphan", 2000));
		expect(await readSessionInfo(path)).toBeNull();
	});
});
