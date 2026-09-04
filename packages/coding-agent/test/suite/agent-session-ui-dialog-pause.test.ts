import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.js";
import { createHarness, type Harness } from "./harness.js";

type SessionWithDialogInternals = {
	_withDialogTracking(uiContext: ExtensionUIContext): ExtensionUIContext;
	_pendingUiDialogs: number;
};

/** Every member that settles only on user input. Missing one leaves the turn abortable. */
const BLOCKING_DIALOGS = ["select", "confirm", "input", "editor", "custom"] as const;

function stubUiContext(): ExtensionUIContext {
	const noop = vi.fn();
	return {
		select: noop,
		confirm: noop,
		input: noop,
		editor: noop,
		custom: noop,
		notify: noop,
		onTerminalInput: () => () => {},
		setStatus: noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
	} as unknown as ExtensionUIContext;
}

describe("extension UI dialogs pause the stall watchdog", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([...BLOCKING_DIALOGS])("counts %s while it is open and releases it when it settles", async (name) => {
		const harness = await createHarness({ settings: { stallWatchdog: { enabled: true } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithDialogInternals;

		let release!: (value: unknown) => void;
		const gated = new Promise<unknown>((resolve) => {
			release = resolve;
		});
		const uiContext = stubUiContext();
		(uiContext as unknown as Record<string, unknown>)[name] = () => gated;
		const tracked = internals._withDialogTracking(uiContext);

		expect(internals._pendingUiDialogs).toBe(0);
		const open = (tracked as unknown as Record<string, () => Promise<unknown>>)[name]();
		expect(internals._pendingUiDialogs).toBe(1);

		release("done");
		await expect(open).resolves.toBe("done");
		expect(internals._pendingUiDialogs).toBe(0);
	});

	it("releases the count when a dialog rejects", async () => {
		const harness = await createHarness({ settings: { stallWatchdog: { enabled: true } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithDialogInternals;
		const uiContext = stubUiContext();
		uiContext.confirm = () => Promise.reject(new Error("dialog blew up"));
		const tracked = internals._withDialogTracking(uiContext);

		await expect(tracked.confirm("t", "m")).rejects.toThrow("dialog blew up");
		expect(internals._pendingUiDialogs).toBe(0);
	});

	it("leaves the non-blocking notify alone", async () => {
		const harness = await createHarness({ settings: { stallWatchdog: { enabled: true } } });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithDialogInternals;
		const notify = vi.fn();
		const tracked = internals._withDialogTracking({ ...stubUiContext(), notify });

		tracked.notify("hello");

		expect(notify).toHaveBeenCalledWith("hello");
		expect(internals._pendingUiDialogs).toBe(0);
	});
});
