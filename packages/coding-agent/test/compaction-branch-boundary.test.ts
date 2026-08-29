import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../src/core/compaction/index.js";
import { SessionManager } from "../src/core/session-manager.js";

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

describe("collectEntriesForBranchSummary stops at compaction (scan2 C6)", () => {
	it("includes the compaction entry but nothing older", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "old exploration", timestamp: Date.now() });
		const asst1 = manager.appendMessage(createAssistantMessage("old reply"));
		manager.appendCompaction("old summary", user1, 5000);
		const user2 = manager.appendMessage({ role: "user", content: "recent question", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("recent reply"));
		const leaf = manager.getLeafId();

		const { entries } = collectEntriesForBranchSummary(manager, leaf, user1);

		const ids = entries.map((entry) => entry.id);
		expect(ids).toContain(user2);
		expect(ids).not.toContain(user1);
		expect(ids).not.toContain(asst1);
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
		// The compaction boundary is the oldest collected entry.
		expect(entries[0].type).toBe("compaction");
	});
});
