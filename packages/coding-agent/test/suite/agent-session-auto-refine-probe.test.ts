import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionWithRefineProbe = {
	_autoRefineAllowedForSession(): boolean;
	_localHarnessStateDir(): string | undefined;
	_autoRefineWritableProbe: { at: number; allowed: boolean } | undefined;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_rlmDepth: number;
};

/**
 * The suite harness builds a depth-1 (RLM child) session, and the probe only runs
 * for a root session, so the depth is set to the value the code path requires.
 */
function rootSession(harness: Harness): SessionWithRefineProbe {
	const internals = harness.session as unknown as SessionWithRefineProbe;
	internals._rlmDepth = 0;
	return internals;
}

/**
 * The probe runs on the session event queue and loads the whole local harness
 * store, so the claim "this is cheaper now" is a call count, not a timing.
 * Counting does not mock behaviour: the real implementation still runs.
 */
describe("_autoRefineAllowedForSession probe cost", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resolves the harness directory once per call and caches the verdict for the TTL", async () => {
		// A persisted session, so there is an artifact directory and therefore a local
		// harness state dir; without one the method returns before probing anything.
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = rootSession(harness);
		expect(internals._localHarnessStateDir()).toBeTypeOf("string");

		const spy = vi.spyOn(internals, "_localHarnessStateDir");
		const first = internals._autoRefineAllowedForSession();
		const second = internals._autoRefineAllowedForSession();
		const third = internals._autoRefineAllowedForSession();

		expect([second, third]).toEqual([first, first]);
		// One call for the first (uncached) probe, then the TTL serves the rest.
		// Before the fix this was two calls per invocation and no cache at all.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(internals._autoRefineWritableProbe).toBeDefined();
	});

	it("re-probes after the cache is invalidated", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = rootSession(harness);

		internals._autoRefineAllowedForSession();
		expect(internals._autoRefineWritableProbe).toBeDefined();

		await internals._invalidatePendingAutoRefineForBranchChange();
		expect(internals._autoRefineWritableProbe).toBeUndefined();

		const spy = vi.spyOn(internals, "_localHarnessStateDir");
		internals._autoRefineAllowedForSession();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
