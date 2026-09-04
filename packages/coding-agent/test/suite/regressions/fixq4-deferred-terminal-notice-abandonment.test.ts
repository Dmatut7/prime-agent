/**
 * FIX-Q4 regression: deferred RLM terminal notices must not pin a session
 * forever. After an abort the pump is suspended, flush is a no-op, and the
 * notices would keep isSessionActive true indefinitely (never passivated,
 * quiescence waits spin). Past the abandonment threshold the session attempts
 * delivery via the normal flush and otherwise abandons the notices, becoming
 * evictable, with a record of the attempt.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRlmChildTerminalNoticeMessage } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const STALE_MS = 6 * 60_000;

function terminalNotice(id: string) {
	return createRlmChildTerminalNoticeMessage({
		kind: "cancelled",
		childId: id,
		sessionName: "worker",
		reason: "aborted before delivery",
	});
}

describe("FIX-Q4 stale deferred terminal notices stop pinning the session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("pins while fresh, abandons past the threshold, and becomes evictable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		const notice = terminalNotice("child-fix-q4");
		harness.session.restorePendingNextTurnMessages([notice]);

		// Fresh deferral pins the session (FIX-Q2 behavior preserved).
		expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
		expect(harness.session.isSessionActive).toBe(true);

		// Below the threshold nothing is abandoned.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + 60_000);
		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();
		expect(harness.session.isSessionActive).toBe(true);

		// Past the threshold the delivery attempt (flush) fails against the
		// suspended pump and the notice is abandoned with a record.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);
		expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(harness.session.isSessionActive).toBe(false);
	});

	it("does not abandon or flush when isSessionActive is merely read", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		harness.session.restorePendingNextTurnMessages([terminalNotice("child-pure-getter")]);

		// Backdate past the threshold. Reading activity is a poll path (session list,
		// roster, subagent snapshots), so it must not discard a child's report or
		// admit a turn action just because somebody asked whether the session is busy.
		const internals = harness.session as unknown as { _rlmTerminalNoticeDeferredSince: number | undefined };
		internals._rlmTerminalNoticeDeferredSince = Date.now() - STALE_MS;

		// Stale notices stop pinning the session, which is the same answer the old
		// flush-then-recheck shape gave - but now without the side effects.
		for (let i = 0; i < 5; i++) expect(harness.session.isSessionActive).toBe(false);

		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
	});

	it("abandons on its own timer without anything reading isSessionActive", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		vi.useFakeTimers();
		try {
			harness.session.restorePendingNextTurnMessages([terminalNotice("child-own-driver")]);
			expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
			expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();

			// Nobody reads isSessionActive here. The threshold must still fire, because
			// a session that nobody polls used to keep its stale notices forever.
			await vi.advanceTimersByTimeAsync(STALE_MS + 1000);

			expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers through the flush attempt when the pump can run again", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("notice delivered")]);

		const pause = harness.session.acquireSessionInputPause();
		const notice = terminalNotice("child-fix-q4-deliver");
		harness.session.restorePendingNextTurnMessages([notice]);
		expect(harness.session.isSessionActive).toBe(true);
		pause.release();

		// Past the threshold, but the pump is runnable again: the flush attempt
		// delivers, so nothing is abandoned.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);
		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();

		await harness.session.waitForIdle();
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.content === notice.content),
		).toBe(true);
	});
});
