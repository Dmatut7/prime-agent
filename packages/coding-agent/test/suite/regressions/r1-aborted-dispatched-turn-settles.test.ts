/**
 * R1 regression: aborting a turn that the input pump dispatched from the visible
 * queue (steering/follow-up/agent-message rows) left the action stuck in
 * `committing`/`running` forever. requestAbort only cancels queue-invisible
 * turns, and the pump's deferred-error branch only rolls back undelivered work,
 * so `unfinishedActionCount` stayed >= 1: `isSessionActive` never cleared,
 * `wait_for_idle` and RLM quiescence hung, and eviction stayed blocked.
 * requestAbort must settle delivered dispatched turns (the delivered messages
 * stay in the transcript); undelivered work still rolls back to the queue.
 */

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.js";

/** A response that holds its gate open until released or the stream aborts. */
function gatedResponse(gate: Promise<void>, text: string): FauxResponseStep {
	return async (_context, options) => {
		const signal = options?.signal;
		await Promise.race([
			gate,
			new Promise<void>((resolve) => {
				if (!signal) return;
				if (signal.aborted) {
					resolve();
					return;
				}
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
		]);
		return fauxAssistantMessage(text);
	};
}

function messageText(texts: string[], expected: string): boolean {
	return texts.includes(expected);
}

describe("R1 abort settles a dispatched queued turn", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("leaves no unfinished actions after aborting a dispatched follow-up", { timeout: 20000 }, async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		harness.setResponses([
			gatedResponse(firstGate, "turn one done"),
			gatedResponse(secondGate, "turn two done"),
			fauxAssistantMessage("after abort"),
		]);

		void harness.session.prompt("first turn").catch(() => {});
		await harness.session.followUp("parked follow-up");
		expect(harness.session.queuedActionCount).toBe(1);

		// Turn one finishes; the pump dispatches the parked follow-up as turn two.
		releaseFirst();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			if (messageText(getUserTexts(harness), "parked follow-up")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(messageText(getUserTexts(harness), "parked follow-up")).toBe(true);
		expect(harness.session.isStreaming).toBe(true);

		harness.session.requestAbort();
		await harness.session.abort();
		releaseSecond();

		// The dispatched turn was delivered (its user message stays in the
		// transcript) but its action lifecycle must be terminal now.
		expect(harness.session.unfinishedActionCount).toBe(0);
		expect(harness.session.isStreaming).toBe(false);

		const idle = await Promise.race([
			harness.session.waitForIdle().then(() => ({ ok: true as const })),
			new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 2000)),
		]);
		expect(idle).toEqual({ ok: true });
		expect(harness.session.isSessionActive).toBe(false);

		// The suspended pump still resumes for later work.
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		await harness.session.prompt("after abort");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toContain("after abort");
	});
});
