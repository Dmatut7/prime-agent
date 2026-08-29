/**
 * Session stall watchdog: escalates when a running turn goes silent.
 *
 * The host arms the watchdog when a turn starts and feeds it every observed
 * session/agent event via `touch()`. If no activity arrives within
 * `warnAfterMs` the watchdog fires the `"warn"` stage; if silence then reaches
 * `abortAfterMs` it fires the `"abort"` stage. After an abort it waits a grace
 * period for the run to settle and fires `"abort_unsettled"` once if it never
 * does, then gives up (no infinite abort loops).
 *
 * Timers and the clock are injectable so tests can drive it deterministically
 * without fake global timers.
 */

export interface StallWatchdogTimers {
	setTimeout: (callback: () => void, delayMs: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	now: () => number;
}

const defaultTimers: StallWatchdogTimers = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	now: () => Date.now(),
};

export type StallWatchdogStage = "warn" | "abort" | "abort_unsettled";

export interface StallWatchdogStageInfo {
	stage: StallWatchdogStage;
	/** Milliseconds without activity when the stage fired. */
	silentMs: number;
	armedAt: number;
	lastActivityAt: number;
}

export interface StallWatchdogOptions {
	/** Whether the watchdog is active. Pass a function to read live from settings. */
	enabled: boolean | (() => boolean);
	/**
	 * Silence duration that fires the `"warn"` stage. Must be > 0 when enabled.
	 * Pass a function to read the threshold live so settings changes take effect
	 * without re-constructing the watchdog.
	 */
	warnAfterMs: number | (() => number);
	/**
	 * Silence duration that fires the `"abort"` stage. Must be greater than
	 * `warnAfterMs`; undefined disables auto-abort (warn-only watchdog).
	 * Pass a function to read the threshold live so settings changes take effect.
	 */
	abortAfterMs?: number | (() => number | undefined);
	/** How long to wait after the abort stage for the run to settle. Default: 10s. */
	abortSettleGraceMs?: number;
	/**
	 * Checked when a timer fires. While true, escalation is deferred by one full
	 * `warnAfterMs` window instead of firing, so phases that legitimately own the
	 * turn boundary (compaction, branch summaries) cannot trigger false alarms.
	 */
	isPaused?: () => boolean;
	onStage: (info: StallWatchdogStageInfo) => void;
	timers?: StallWatchdogTimers;
}

export type StallWatchdogState = "idle" | "armed" | "warned" | "aborting";

const DEFAULT_ABORT_SETTLE_GRACE_MS = 10_000;

export class StallWatchdog {
	private readonly options: StallWatchdogOptions;
	private readonly timers: StallWatchdogTimers;
	private state: StallWatchdogState = "idle";
	private armedAt = 0;
	private lastActivityAt = 0;
	private timerHandle: unknown = undefined;

	constructor(options: StallWatchdogOptions) {
		this.options = options;
		this.timers = options.timers ?? defaultTimers;
	}

	private get warnAfterMs(): number {
		const v = this.options.warnAfterMs;
		return typeof v === "function" ? v() : v;
	}

	private get abortAfterMs(): number | undefined {
		const v = this.options.abortAfterMs;
		return typeof v === "function" ? v() : v;
	}

	get currentState(): StallWatchdogState {
		return this.state;
	}

	get lastActivity(): number {
		return this.lastActivityAt;
	}

	private get active(): boolean {
		const enabled = typeof this.options.enabled === "function" ? this.options.enabled() : this.options.enabled;
		return enabled && this.warnAfterMs > 0;
	}

	/** Start watching a turn. Re-arming resets the escalation state. */
	arm(): void {
		if (!this.active) return;
		this.armedAt = this.timers.now();
		this.lastActivityAt = this.armedAt;
		this.state = "armed";
		this.scheduleWarn();
	}

	/** Record activity: resets the warn deadline and cancels any pending escalation. */
	touch(): void {
		if (!this.active || this.state === "idle") return;
		// While aborting (waiting for settle), touches must not re-arm: doing so
		// cancels the settle timer and restarts the warn→abort cycle, contradicting
		// the "no infinite abort loops" guarantee in fireAbortUnsettled.
		if (this.state === "aborting") return;
		this.lastActivityAt = this.timers.now();
		this.state = "armed";
		this.scheduleWarn();
	}

	/** Stop watching: the turn ended (or the session is going away). */
	disarm(): void {
		this.clearTimer();
		this.state = "idle";
	}

	/** Alias of `disarm()` for ownership-clarity at teardown. */
	dispose(): void {
		this.disarm();
	}

	private clearTimer(): void {
		if (this.timerHandle !== undefined) {
			this.timers.clearTimeout(this.timerHandle);
			this.timerHandle = undefined;
		}
	}

	private scheduleWarn(): void {
		this.clearTimer();
		this.timerHandle = this.timers.setTimeout(() => this.fireWarn(), this.warnAfterMs);
	}

	private fireWarn(): void {
		this.timerHandle = undefined;
		if (this.state === "idle") return;
		if (this.options.isPaused?.()) {
			// Snooze: the paused phase legitimately owns the turn boundary, so its
			// silent time is not stall evidence. Rebase activity and re-check after
			// another full warn window once the pause lifts.
			this.lastActivityAt = this.timers.now();
			this.scheduleWarn();
			return;
		}
		this.state = "warned";
		this.emitStage("warn");
		const abortAfterMs = this.abortAfterMs;
		if (abortAfterMs === undefined || abortAfterMs <= this.warnAfterMs) return;
		const delayMs = Math.max(0, abortAfterMs - (this.timers.now() - this.lastActivityAt));
		this.timerHandle = this.timers.setTimeout(() => this.fireAbort(), delayMs);
	}

	private fireAbort(): void {
		this.timerHandle = undefined;
		if (this.state !== "warned") return;
		if (this.options.isPaused?.()) {
			this.state = "armed";
			this.scheduleWarn();
			return;
		}
		this.state = "aborting";
		this.emitStage("abort");
		const graceMs = this.options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
		this.timerHandle = this.timers.setTimeout(() => this.fireAbortUnsettled(), graceMs);
	}

	private fireAbortUnsettled(): void {
		this.timerHandle = undefined;
		if (this.state !== "aborting") return;
		this.emitStage("abort_unsettled");
		// Give up: repeated aborts cannot fix a wedged runtime and would loop forever.
		this.state = "idle";
	}

	private emitStage(stage: StallWatchdogStage): void {
		this.options.onStage({
			stage,
			silentMs: this.timers.now() - this.lastActivityAt,
			armedAt: this.armedAt,
			lastActivityAt: this.lastActivityAt,
		});
	}
}
