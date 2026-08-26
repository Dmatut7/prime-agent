import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * An aborted turn skips the threshold compaction at its own end, which defers the
 * work onto the next prompt: the user's message then waits for a full
 * summarization round trip before the turn it belongs to can even start.
 */
const SUMMARIZER_DELAY_MS = 400;

function isSummarizationCall(systemPrompt: string | undefined): boolean {
	return systemPrompt?.includes("summariz") === true || systemPrompt?.includes("summary") === true;
}

/** Serves turn responses immediately and summarization calls slowly, so the block is measurable. */
function slowSummarizerStep(turnText: string): FauxResponseStep {
	return async (context) => {
		if (isSummarizationCall(context.systemPrompt)) {
			await new Promise((resolve) => setTimeout(resolve, SUMMARIZER_DELAY_MS));
			return fauxAssistantMessage("## Goal\nDeferred summary.\n\n## Next Steps\n1. Continue.");
		}
		return fauxAssistantMessage(turnText);
	};
}

describe("threshold compaction deferred by an aborted turn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createOverThresholdHarness(): Promise<Harness> {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 6_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		return harness;
	}

	/** Pushes context past `contextWindow - reserveTokens` and leaves the turn aborted. */
	async function fillContextWithAbortedTurn(harness: Harness): Promise<void> {
		harness.setResponses([fauxAssistantMessage("partial answer", { stopReason: "aborted" })]);
		await harness.session.prompt(`context filler ${"x".repeat(40_000)}`);
		await harness.session.waitForIdle();
	}

	it("skips compaction when the turn that crossed the threshold was aborted", async () => {
		const harness = await createOverThresholdHarness();
		await fillContextWithAbortedTurn(harness);

		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("makes the next prompt wait for the deferred compaction before its turn starts", async () => {
		const harness = await createOverThresholdHarness();
		await fillContextWithAbortedTurn(harness);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		const observed: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => observed.push(event.type));
		harness.setResponses([slowSummarizerStep("reply after deferred compaction"), slowSummarizerStep("unused")]);

		const startedAt = Date.now();
		await harness.session.prompt("what did we decide?");
		const elapsedMs = Date.now() - startedAt;
		unsubscribe();

		const compactionIndex = observed.indexOf("compaction_start");
		const agentStartIndex = observed.indexOf("agent_start");
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(agentStartIndex).toBeGreaterThanOrEqual(0);
		expect(compactionIndex).toBeLessThan(agentStartIndex);
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({ reason: "threshold" });
		// The summarization round trip is inside the user's wait, not beside it.
		expect(elapsedMs).toBeGreaterThanOrEqual(SUMMARIZER_DELAY_MS);
	});
});
