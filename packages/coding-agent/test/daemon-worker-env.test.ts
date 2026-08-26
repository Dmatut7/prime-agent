import { describe, expect, it } from "vitest";
import { applySupervisorIdentityEnvFence } from "../src/modes/daemon/daemon-worker-env.js";

describe("applySupervisorIdentityEnvFence", () => {
	it("restores identity and locale keys from the supervisor environment", () => {
		const supervisorEnv = {
			HOME: "/Users/supervisor",
			USER: "supervisor",
			LOGNAME: "supervisor",
			LANG: "C.UTF-8",
			LC_ALL: "C",
			LC_TIME: "C",
			TZ: "UTC",
			OPENAI_API_KEY: "supervisor-key",
			PATH: "/usr/bin",
		};
		const merged = {
			...supervisorEnv,
			HOME: "/tmp/other-home",
			LANG: "zh_CN.UTF-8",
			LC_ALL: "zh_CN.UTF-8",
			LC_TIME: "zh_CN.UTF-8",
			USER: "other",
			LOGNAME: "other",
			TZ: "Asia/Shanghai",
			OPENAI_API_KEY: "client-key",
			PATH: "/client/bin:/usr/bin",
			CUSTOM_TOKEN: "keep-me",
		};

		const fenced = applySupervisorIdentityEnvFence(merged, supervisorEnv);

		expect(fenced.HOME).toBe("/Users/supervisor");
		expect(fenced.USER).toBe("supervisor");
		expect(fenced.LOGNAME).toBe("supervisor");
		expect(fenced.LANG).toBe("C.UTF-8");
		expect(fenced.LC_ALL).toBe("C");
		expect(fenced.LC_TIME).toBe("C");
		expect(fenced.TZ).toBe("UTC");
		expect(fenced.OPENAI_API_KEY).toBe("client-key");
		expect(fenced.PATH).toBe("/client/bin:/usr/bin");
		expect(fenced.CUSTOM_TOKEN).toBe("keep-me");
	});

	it("restores USERPROFILE from the supervisor environment", () => {
		const supervisorEnv = {
			HOME: "C:\\Users\\supervisor",
			USERPROFILE: "C:\\Users\\supervisor",
		};
		const merged = {
			HOME: "C:\\Users\\other",
			USERPROFILE: "C:\\Users\\other",
			OPENAI_API_KEY: "client-key",
		};

		const fenced = applySupervisorIdentityEnvFence(merged, supervisorEnv);

		expect(fenced.HOME).toBe("C:\\Users\\supervisor");
		expect(fenced.USERPROFILE).toBe("C:\\Users\\supervisor");
		expect(fenced.OPENAI_API_KEY).toBe("client-key");
	});

	it("restores supervisor PRIME_AGENT_INTERNAL_* without wiping worker internals", () => {
		const supervisorEnv = {
			HOME: "/Users/supervisor",
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: "/tmp/supervisor-owners",
			PRIME_AGENT_INTERNAL_OTHER: "supervisor-value",
		};
		const merged = {
			HOME: "/tmp/other-home",
			PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR: "/tmp/evil-owners",
			PRIME_AGENT_INTERNAL_OTHER: "client-value",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
			PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "worker-token",
		};

		const fenced = applySupervisorIdentityEnvFence(merged, supervisorEnv);

		expect(fenced.HOME).toBe("/Users/supervisor");
		expect(fenced.PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR).toBe("/tmp/supervisor-owners");
		expect(fenced.PRIME_AGENT_INTERNAL_OTHER).toBe("supervisor-value");
		expect(fenced.PRIME_AGENT_INTERNAL_DAEMON_WORKER).toBe("1");
		expect(fenced.PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN).toBe("worker-token");
	});

	it("unsets identity keys that the supervisor does not have", () => {
		const supervisorEnv = {
			HOME: "/Users/supervisor",
		};
		const merged = {
			HOME: "/tmp/other-home",
			LANG: "zh_CN.UTF-8",
			LC_ALL: "zh_CN.UTF-8",
		};

		const fenced = applySupervisorIdentityEnvFence(merged, supervisorEnv);

		expect(fenced.HOME).toBe("/Users/supervisor");
		expect(fenced.LANG).toBeUndefined();
		expect(fenced.LC_ALL).toBeUndefined();
	});
});
