import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	confirmShareIfSecrets,
	createShareTempHtmlFile,
	findShareSecretHits,
	formatShareSecretWarning,
} from "../src/core/share-session.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describe("findShareSecretHits", () => {
	it("returns unique types and never the matched secret text", () => {
		const secret = "sk-test1234567890abcdef";
		const hits = findShareSecretHits(`please use ${secret} and Bearer abcdefghijklmnop`);
		expect(hits).toEqual(["API key (sk-)", "Bearer token"]);
		expect(hits.join(" ")).not.toContain(secret);
		expect(hits.join(" ")).not.toContain("abcdefghijklmnop");
	});

	it("detects AKIA and ghp_ shapes", () => {
		const hits = findShareSecretHits("AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz1234");
		expect(hits).toEqual(["AWS access key (AKIA)", "GitHub token (ghp_)"]);
		expect(JSON.stringify(hits)).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(JSON.stringify(hits)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234");
	});

	it("returns nothing when the session has no secret shapes", () => {
		expect(findShareSecretHits("hello world, no credentials here")).toEqual([]);
	});
});

describe("confirmShareIfSecrets", () => {
	it("does not prompt when nothing looks like a secret", async () => {
		const confirm = vi.fn(async () => false);
		await expect(confirmShareIfSecrets("clean session text", confirm)).resolves.toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("prompts with types only and honors cancellation", async () => {
		const secret = "sk-live1234567890secret";
		const confirm = vi.fn(async (title: string, message: string) => {
			expect(title).toBe("Share session");
			expect(message).toContain("API key (sk-)");
			expect(message).toContain("full session");
			expect(message).not.toContain(secret);
			return false;
		});
		await expect(confirmShareIfSecrets(`key=${secret}`, confirm)).resolves.toBe(false);
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("continues when the user confirms", async () => {
		const confirm = vi.fn(async () => true);
		await expect(confirmShareIfSecrets("ghp_abcdefghijklmnopqrstuvwxyz1234", confirm)).resolves.toBe(true);
	});
});

describe("formatShareSecretWarning", () => {
	it("lists types without inventing secret values", () => {
		const warning = formatShareSecretWarning(["API key (sk-)"]);
		expect(warning.message).toContain("- API key (sk-)");
		expect(warning.message).not.toMatch(/sk-[A-Za-z0-9]/);
	});
});

describePosix("createShareTempHtmlFile", () => {
	it("creates a 0600 file in a 0700 unique directory, not os.tmpdir()/session.html", () => {
		const temp = createShareTempHtmlFile();
		try {
			expect(temp.path).not.toBe(`${tmpdir()}/session.html`);
			expect(temp.path.endsWith(".html")).toBe(true);
			expect(statSync(temp.directory).mode & 0o777).toBe(0o700);
			expect(statSync(temp.path).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(temp.directory, { recursive: true, force: true });
		}
	});
});
