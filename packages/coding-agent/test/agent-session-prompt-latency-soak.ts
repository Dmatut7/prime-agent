/**
 * Does prompt latency grow as a session ages?
 *
 * Runs many real turns through AgentSession against the faux provider, so model
 * time is ~0 and every millisecond measured is local work: context assembly,
 * compaction checks, session persistence, and event fan-out. Reports latency per
 * bucket of turns so growth is visible rather than inferred.
 *
 *   cd packages/coding-agent
 *   TURNS=400 npx tsx test/agent-session-prompt-latency-soak.ts
 */
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarness, type Harness } from "./suite/harness.js";

const TURNS = Number.parseInt(process.env.TURNS ?? "300", 10);
const BUCKET = Number.parseInt(process.env.BUCKET ?? "25", 10);
const ASSISTANT_CHARS = Number.parseInt(process.env.ASSISTANT_CHARS ?? "8000", 10);
const USER_CHARS = Number.parseInt(process.env.USER_CHARS ?? "2000", 10);
const CONTEXT_WINDOW = Number.parseInt(process.env.CONTEXT_WINDOW ?? "200000", 10);

const SUMMARY_TEXT = [
	"## Goal",
	"Keep working through the soak.",
	"",
	"## Progress",
	"### Done",
	"- [x] Earlier turns summarized.",
	"",
	"## Next Steps",
	"1. Continue.",
].join("\n");

function isSummarizationCall(systemPrompt: string | undefined): boolean {
	if (!systemPrompt) return false;
	return systemPrompt.includes("summariz") || systemPrompt.includes("summary");
}

/** Serves both the turn response and any compaction summarization the turn triggers. */
function turnStep(turn: number): FauxResponseStep {
	return (context) => {
		if (isSummarizationCall(context.systemPrompt)) {
			return fauxAssistantMessage(SUMMARY_TEXT);
		}
		return fauxAssistantMessage(`reply ${turn}: ${"detail ".repeat(Math.ceil(ASSISTANT_CHARS / 7))}`);
	};
}

function pct(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function avg(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rssMb(): number {
	return process.memoryUsage().rss / 1024 / 1024;
}

function heapMb(): number {
	return process.memoryUsage().heapUsed / 1024 / 1024;
}

function sessionFileMb(harness: Harness): number {
	const file = harness.sessionManager.getSessionFile();
	if (!file) return 0;
	try {
		return statSync(file).size / 1024 / 1024;
	} catch {
		return 0;
	}
}

async function main(): Promise<void> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
		persistSession: true,
	});

	console.log("=== PROMPT LATENCY SOAK ===");
	console.log(JSON.stringify({ TURNS, BUCKET, ASSISTANT_CHARS, USER_CHARS, CONTEXT_WINDOW }));
	console.log(
		"bucket  turns        p50      p95      max     avg   msgs  entries   sessionMB   heapMB   rssMB  compactions",
	);

	const latencies: number[] = [];
	let bucketLatencies: number[] = [];
	let reportedCompactions = 0;

	for (let turn = 0; turn < TURNS; turn++) {
		// Extra steps absorb a summarization call when this turn triggers compaction.
		harness.setResponses([turnStep(turn), turnStep(turn), turnStep(turn)]);
		const prompt = `turn ${turn} question: ${"context ".repeat(Math.ceil(USER_CHARS / 8))}`;

		const startedAt = performance.now();
		await harness.session.prompt(prompt);
		await harness.session.waitForIdle();
		const elapsed = performance.now() - startedAt;

		latencies.push(elapsed);
		bucketLatencies.push(elapsed);

		if (bucketLatencies.length === BUCKET || turn === TURNS - 1) {
			const compactions = harness.eventsOfType("compaction_start").length;
			const first = turn - bucketLatencies.length + 1;
			console.log(
				[
					String(Math.floor(first / BUCKET)).padStart(6),
					`${first}-${turn}`.padStart(9),
					pct(bucketLatencies, 50).toFixed(0).padStart(9),
					pct(bucketLatencies, 95).toFixed(0).padStart(8),
					Math.max(...bucketLatencies)
						.toFixed(0)
						.padStart(8),
					avg(bucketLatencies).toFixed(0).padStart(7),
					String(harness.session.messages.length).padStart(6),
					String(harness.sessionManager.getEntries().length).padStart(8),
					sessionFileMb(harness).toFixed(1).padStart(11),
					heapMb().toFixed(0).padStart(8),
					rssMb().toFixed(0).padStart(7),
					String(compactions - reportedCompactions).padStart(12),
				].join(" "),
			);
			reportedCompactions = compactions;
			bucketLatencies = [];
		}
	}

	const firstBucket = latencies.slice(0, BUCKET);
	const lastBucket = latencies.slice(-BUCKET);
	const growth = avg(lastBucket) / Math.max(1, avg(firstBucket));

	console.log("\n=== VERDICT ===");
	console.log(
		JSON.stringify(
			{
				turns: TURNS,
				firstBucketAvgMs: Number(avg(firstBucket).toFixed(1)),
				lastBucketAvgMs: Number(avg(lastBucket).toFixed(1)),
				growthRatio: Number(growth.toFixed(2)),
				overallP95Ms: Number(pct(latencies, 95).toFixed(1)),
				maxMs: Number(Math.max(...latencies).toFixed(1)),
				compactions: harness.eventsOfType("compaction_start").length,
				messages: harness.session.messages.length,
				retainedSessionEntries: harness.sessionManager.getEntries().length,
				sessionFileMb: Number(sessionFileMb(harness).toFixed(1)),
				heapMb: Number(heapMb().toFixed(0)),
				rssMb: Number(rssMb().toFixed(0)),
			},
			null,
			2,
		),
	);
	if (growth >= 2) {
		console.log(`GROWTH DETECTED: prompt latency grew ${growth.toFixed(2)}x from the first to the last bucket.`);
	} else {
		console.log(`No superlinear growth: prompt latency grew ${growth.toFixed(2)}x across ${TURNS} turns.`);
	}

	harness.cleanup();
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
