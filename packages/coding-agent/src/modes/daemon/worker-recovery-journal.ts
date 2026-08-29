import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { repairTruncatedTrailingLine } from "../../utils/file-lines.js";

export interface WorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

function parseRecords(path: string): Map<string, WorkerRecoveryRecord> {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return latest;
		}
		throw error;
	}
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		let record: WorkerRecoveryRecord;
		try {
			record = JSON.parse(line) as WorkerRecoveryRecord;
		} catch {
			continue;
		}
		if (
			record.version === 1 &&
			typeof record.activeSessionId === "string" &&
			typeof record.sessionId === "string" &&
			typeof record.busy === "boolean" &&
			typeof record.operation === "string"
		) {
			latest.set(record.activeSessionId, record);
		}
	}
	return latest;
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.cleanStaleCompactionTemps();
		// A crash can leave a torn final line; load skips it, so drop it from disk
		// too — the next append must not glue onto the torn bytes.
		repairTruncatedTrailingLine(path);
		this.latest = parseRecords(path);
	}

	private cleanStaleCompactionTemps(): void {
		const prefix = `${basename(this.path)}.`;
		try {
			for (const name of readdirSync(dirname(this.path))) {
				if (name.startsWith(prefix) && name.endsWith(".tmp")) {
					rmSync(join(dirname(this.path), name), { force: true });
				}
			}
		} catch {
			// Stale temps only waste space; their cleanup must not break startup.
		}
	}

	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		const previous = this.latest.get(input.activeSessionId);
		if (
			previous?.busy === input.busy &&
			previous.operation === input.operation &&
			previous.sessionFile === input.sessionFile
		) {
			return;
		}
		const record: WorkerRecoveryRecord = {
			version: 1,
			...input,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		this.latest.set(record.activeSessionId, record);
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			this.compact();
		}
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path).values()];
	}

	private append(record: WorkerRecoveryRecord): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.path, 0o600);
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		const content = `${[...this.latest.values()].map((record) => JSON.stringify(record)).join("\n")}\n`;
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			writeSync(descriptor, content);
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(tempPath, this.path);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			// After a successful rename the temp no longer exists; on failure this
			// removes the partial file instead of leaving it for the next startup.
			rmSync(tempPath, { force: true });
		}
	}
}
