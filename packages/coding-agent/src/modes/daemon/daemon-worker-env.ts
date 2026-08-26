/** Identity and locale keys that must stay aligned with the supervisor process. */
export const SUPERVISOR_IDENTITY_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_TIME",
	"LC_COLLATE",
	"LC_NUMERIC",
	"LC_MONETARY",
	"TZ",
] as const;

/**
 * After merging client launchEnv onto the supervisor environment, restore keys
 * that affect worker_auth (homedir, locale-sensitive ps lstart) and any
 * PRIME_AGENT_INTERNAL_* values the supervisor already holds. Provider keys and
 * PATH from launchEnv are left alone so client-owned recovery still works.
 */
export function applySupervisorIdentityEnvFence(
	env: NodeJS.ProcessEnv,
	supervisorEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const fenced: NodeJS.ProcessEnv = { ...env };
	for (const key of SUPERVISOR_IDENTITY_ENV_KEYS) {
		const value = supervisorEnv[key];
		if (value === undefined) {
			delete fenced[key];
		} else {
			fenced[key] = value;
		}
	}
	for (const key of Object.keys(supervisorEnv)) {
		if (!key.startsWith("PRIME_AGENT_INTERNAL_")) {
			continue;
		}
		const value = supervisorEnv[key];
		if (value === undefined) {
			delete fenced[key];
		} else {
			fenced[key] = value;
		}
	}
	return fenced;
}
