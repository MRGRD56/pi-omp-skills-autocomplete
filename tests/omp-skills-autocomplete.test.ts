/**
 * Behavior tests for the OMP `$skill` autocomplete extension.
 *
 * These tests drive the extension through its only public entrypoint (the
 * default export) with a small fake `ExtensionAPI`/UI bridge, exactly the way
 * the OMP interactive host wires it: the host captures the editor component
 * factory from `ctx.ui.setEditorComponent(...)` and stacks every factory from
 * `ctx.ui.addAutocompleteProvider(...)` on top of the built-in provider.
 *
 * The injected host modules (`CustomEditor`, `UserMessageComponent`,
 * `setThemeInstance`) are the real pi-tui implementations and the editor is
 * constructed through the host factory, so input and rendering assertions
 * exercise real editor behavior.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CombinedAutocompleteProvider, getKeybindings } from "@oh-my-pi/pi-tui";
import type { AutocompleteItem, AutocompleteProvider, EditorTheme } from "@oh-my-pi/pi-tui";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import skillsAutocomplete from "../omp-skills-autocomplete";

/** Command fixtures as the host exposes them: skills are `skill:<name>` entries tagged `skill`. */
const SKILL_COMMANDS = [
	{ name: "skill:alpha", description: "Alpha skill", source: "skill" },
	{ name: "skill:beta", description: "Beta skill", source: "skill" },
	{ name: "skill:gamma", description: "Gamma skill", source: "skill" },
	{ name: "compact", description: "Not a skill command", source: "prompt" },
];

const CUSTOM_TYPE = "skills-autocomplete-prompt";

const ESC = "\x1b";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const TAB = "\t";
const ENTER = "\r";
const END = "\x05";
const BACKSPACE = "\x7f";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const RENDER_WIDTH = 80;

type FakeTui = {
	requestRender: () => void;
	getShowHardwareCursor: () => boolean;
};

type FakeEditor = CustomEditor & {
	onSubmit: ((text: string) => void) | undefined;
};

type Handler = (...args: unknown[]) => unknown;

/** Shape the extension expects from `pi`, without importing the host's type-only package. */
type ExtensionApi = Parameters<typeof skillsAutocomplete>[0];

type ExtensionUiBridge = {
	hasUI: boolean;
	ui: {
		theme: Theme;
		notify: (message: string) => void;
		setEditorComponent: (factory: (...args: unknown[]) => FakeEditor) => void;
		addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
	};
};

type Harness = {
	theme: Theme;
	/** Compose every provider factory the extension registered, like the host does. */
	compose: (base: AutocompleteProvider) => AutocompleteProvider;
	/** Instantiate the editor the extension installed, through the host factory. */
	editor: (provider?: AutocompleteProvider) => FakeEditor;
	/** Run a lifecycle handler registered on the extension API. */
	fire: (event: string, ...args: unknown[]) => unknown[];
};

function createHarness(commands = SKILL_COMMANDS): Harness {
	const handlers = new Map<string, Handler[]>();
	const providerFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
	const editorFactories: Array<(...args: unknown[]) => FakeEditor> = [];

	const api = {
		setLabel: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getCommands: () => commands,
		pi: { CustomEditor, UserMessageComponent, setThemeInstance },
	};

	skillsAutocomplete(api as unknown as ExtensionApi);

	const theme = loadThemeSync("dark");
	setThemeInstance(theme);
	const ctx: ExtensionUiBridge = {
		hasUI: true,
		ui: {
			theme,
			notify: () => {},
			setEditorComponent: (factory: (...args: unknown[]) => FakeEditor) => {
				editorFactories.push(factory);
			},
			addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
				providerFactories.push(factory);
			},
		},
	};

	const fire = (event: string, ...args: unknown[]): unknown[] =>
		(handlers.get(event) ?? []).map(handler => handler(...args));

	fire("session_start", {}, ctx);

	return {
		theme,
		compose: base => providerFactories.reduce((provider, factory) => factory(provider), base),
		editor: (provider?) => {
			const factory = editorFactories.at(-1);
			if (!factory) throw new Error("extension did not install an editor component");
			const tui: FakeTui = { requestRender: () => {}, getShowHardwareCursor: () => false };
			const instance = factory(tui, injectedTheme(), getKeybindings());
			if (provider) instance.setAutocompleteProvider(provider);
			return instance;
		},
		fire,
	};
}

/** Drain async work until `predicate` holds; provider fixtures resolve through microtasks. */
async function until(predicate: () => boolean, attempts = 500): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition never became true");
}

/** Resolve on the next autocomplete update for which `predicate` holds (real I/O safe). */
function waitForAutocompleteUpdate(editor: FakeEditor, predicate: () => boolean): Promise<void> {
	if (predicate()) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const previous = editor.onAutocompleteUpdate;
	editor.onAutocompleteUpdate = () => {
		previous?.();
		if (!predicate()) return;
		editor.onAutocompleteUpdate = previous;
		resolve();
	};
	return promise;
}

/** Replace `prefix` before the cursor with the item value, the way core providers do. */
function replaceByPrefix(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] ?? "";
	const start = Math.max(0, cursorCol - prefix.length);
	const next = [...lines];
	next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
	return { lines: next, cursorLine, cursorCol: start + item.value.length };
}

/** A base provider with no suggestions, so only the extension's own popup is in play. */
function inertBaseProvider(overrides: Partial<AutocompleteProvider> = {}): AutocompleteProvider {
	return {
		async getSuggestions() {
			return null;
		},
		applyCompletion: replaceByPrefix,
		async getForceFileSuggestions() {
			return null;
		},
		shouldTriggerFileCompletion() {
			return true;
		},
		getInlineHint() {
			return null;
		},
		...overrides,
	};
}

/** Base provider that answers the `@` file trigger with one fake file. */
function atFileBaseProvider(): AutocompleteProvider {
	return inertBaseProvider({
		async getSuggestions(lines, cursorLine, cursorCol) {
			const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
			if (text.startsWith("@")) return { items: [{ value: "@file.txt", label: "file.txt" }], prefix: "@" };
			return null;
		},
	});
}

/** The native autocomplete list core currently holds, exposed through `debugChildren`. */
function nativeAutocompleteList(editor: FakeEditor): {
	handleNativeEvent: (event: { type: "activate"; item: string }) => void;
} {
	const child = editor.debugChildren[0];
	if (!child || !("handleNativeEvent" in child)) throw new Error("no active native autocomplete list");
	return child as { handleNativeEvent: (event: { type: "activate"; item: string }) => void };
}

/**
 * The editor theme the harness injects. Resolved lazily because it reads the
 * active theme singleton, which each test installs before building an editor.
 */
let injectedEditorTheme: EditorTheme | undefined;

function injectedTheme(): EditorTheme {
	injectedEditorTheme ??= getEditorTheme();
	return injectedEditorTheme;
}

/**
 * Rendered SelectList rows only. A row starts with the selection cursor glyph
 * (selected) or the blank selection column (unselected); the composer draft
 * renders the same token with different chrome and must not be counted.
 */
function skillRows(instance: FakeEditor, width = RENDER_WIDTH): string[] {
	const { cursor, inputCursor } = injectedTheme().symbols;
	return instance.render(width).filter(line => {
		const stripped = line.replace(ANSI_RE, "");
		if (stripped.includes(inputCursor)) return false;
		return stripped.startsWith(`${cursor} $`) || /^ {2,}\$/.test(stripped);
	});
}

function renderText(instance: FakeEditor, width = RENDER_WIDTH): string {
	return instance.render(width).join("\n");
}

function deferred<T>() {
	return Promise.withResolvers<T>();
}

const temporaryDirs: string[] = [];

afterEach(() => {
	while (temporaryDirs.length > 0) rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

describe("hidden skill context", () => {
	test("deduplicates valid mentions and ignores unknown tokens", () => {
		const harness = createHarness();
		const result = harness.fire("before_agent_start", {
			prompt: "$alpha please use $alpha and $notreal and $beta",
		})[0] as { message?: { customType: string; content: string; display: boolean; details?: { skills?: string[] } } };
		expect(result.message).toBeDefined();
		expect(result.message!.customType).toBe(CUSTOM_TYPE);
		expect(result.message!.content).toBe("($-Mentioned skills: alpha, beta)");
		expect(result.message!.display).toBe(false);
		expect(result.message!.details?.skills).toEqual(["alpha", "beta"]);
	});

	test("only commands tagged as skills count as installed skills", () => {
		const harness = createHarness([
			{ name: "skill:alpha", description: "Real skill", source: "skill" },
			{ name: "skill:decoy", description: "Skill name shape, other source", source: "extension" },
		]);
		const result = harness.fire("before_agent_start", { prompt: "use $alpha and $decoy" })[0] as {
			message?: { content: string; details?: { skills?: string[] } };
		};

		expect(result.message?.content).toBe("($-Mentioned skills: alpha)");
		expect(result.message?.details?.skills).toEqual(["alpha"]);

		const editor = harness.editor(inertBaseProvider());
		const decorate = editor.decorateText!;
		const decorated = decorate("use $alpha and $decoy", { line: 0, startCol: 0, endCol: 20 });
		expect(decorated.replace(ANSI_RE, "")).toContain("$decoy");
		expect(/\x1b\[[0-9;?]*m\$decoy/.test(decorated)).toBe(false);
	});

	test("injects nothing when every mention is unknown or absent", () => {
		const harness = createHarness();
		expect(harness.fire("before_agent_start", { prompt: "use $notreal and $nope" })[0]).toBeUndefined();
		expect(harness.fire("before_agent_start", { prompt: "plain prompt" })[0]).toBeUndefined();
	});

	test("keeps the submitted prompt untouched", () => {
		const harness = createHarness();
		const event = { prompt: "$alpha keeps its literal text" };
		const before = event.prompt;
		harness.fire("before_agent_start", event);
		expect(event.prompt).toBe(before);
	});
});

describe("$ completion in the real editor", () => {
	test("opens on $ at an accepted token boundary and stays closed otherwise", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.setText("foo(");
		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(3);

		editor.setText("foox");
		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(0);

		editor.setText("");
		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(3);
		editor.handleInput("$");
		expect(editor.getText()).toBe("$$");
		expect(skillRows(editor).length).toBe(0);
	});

	test("accepts the selected skill with Tab without submitting and keeps the tail", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.setText("prefix $be tail");
		for (let i = 0; i < 5; i += 1) editor.handleInput(LEFT);
		expect(editor.getCursor().col).toBe(10);

		editor.handleInput("t");
		expect(editor.getText()).toBe("prefix $bet tail");
		expect(skillRows(editor).length).toBeGreaterThan(0);

		editor.handleInput(TAB);
		expect(editor.getText()).toBe("prefix $beta tail");
		expect(editor.getCursor().col).toBe(12);
	});

	test("accepting while the cursor is inside the token consumes the whole token", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.setText("see $al tail");
		for (let i = 0; i < 6; i += 1) editor.handleInput(LEFT);
		expect(editor.getCursor().col).toBe(6);
		expect(skillRows(editor).length).toBeGreaterThan(0);

		editor.handleInput(TAB);
		expect(editor.getText()).toBe("see $alpha tail");
		expect(editor.getCursor().col).toBe(10);
	});

	test("completes on a multiline prompt at the right line and column", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.setText("first line\nprefix $be");
		editor.handleInput("t");
		editor.handleInput(TAB);

		expect(editor.getLines()).toEqual(["first line", "prefix $beta"]);
		expect(editor.getCursor()).toEqual({ line: 1, col: 12 });
	});

	test("Down + Enter applies the highlighted skill and does not submit the prompt", () => {
		const editor = createHarness().editor(inertBaseProvider());
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);

		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(3);
		editor.handleInput(DOWN);
		editor.handleInput(ENTER);

		expect(editor.getText()).toBe("$beta");
		expect(submitted).toEqual([]);

		editor.handleInput(ENTER);
		expect(submitted).toEqual(["$beta"]);
	});

	test("accepting an already-complete token keeps the popup dismissed", () => {
		const editor = createHarness().editor(inertBaseProvider());
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);

		editor.handleInput("$beta");
		expect(editor.getText()).toBe("$beta");
		expect(skillRows(editor).length).toBe(1);

		// Enter accepts the identical completion: nothing changes, nothing submits.
		editor.handleInput(ENTER);
		expect(editor.getText()).toBe("$beta");
		expect(skillRows(editor).length).toBe(0);
		expect(submitted).toEqual([]);

		// A caret key at the same end-of-line position must not reopen the dismissed list.
		editor.handleInput(END);
		expect(editor.getCursor().col).toBe(5);
		expect(skillRows(editor).length).toBe(0);

		// The next Enter submits the normal prompt.
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["$beta"]);
	});

	test("Escape closes the popup without reopening on a repaint", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(3);

		editor.handleInput(ESC);
		expect(skillRows(editor).length).toBe(0);
		// A repaint with no edit must not resurrect the suppressed popup.
		expect(skillRows(editor).length).toBe(0);
	});

	test("a dismissed popup reopens once the token context changes", () => {
		const editor = createHarness().editor(inertBaseProvider());

		// Editing away and back to the same token clears the dismissal.
		editor.handleInput("$");
		editor.handleInput(ESC);
		expect(skillRows(editor).length).toBe(0);
		editor.handleInput("b");
		expect(skillRows(editor).length).toBeGreaterThan(0);
		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("$");
		expect(skillRows(editor).length).toBe(3);

		// Leaving the token with the caret and returning clears the dismissal too.
		editor.setText("$a $b");
		editor.handleInput(LEFT);
		expect(editor.getCursor().col).toBe(4);
		expect(skillRows(editor).length).toBeGreaterThan(0);
		editor.handleInput(ESC);
		expect(skillRows(editor).length).toBe(0);
		editor.handleInput(LEFT);
		editor.handleInput(RIGHT);
		expect(editor.getCursor().col).toBe(4);
		expect(skillRows(editor).length).toBeGreaterThan(0);
	});

	test("deleting the $ closes the popup", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.handleInput("$");
		expect(skillRows(editor).length).toBe(3);

		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("");
		expect(skillRows(editor).length).toBe(0);
	});

	test("unknown tokens stay plain text and offer no completion", () => {
		const editor = createHarness().editor(inertBaseProvider());

		editor.handleInput("$zzz");
		expect(skillRows(editor).length).toBe(0);

		editor.handleInput(TAB);
		expect(editor.getText()).toBe("$zzz");
	});

	test("completion is one undoable host edit that preserves atoms and the tail", () => {
		const editor = createHarness().editor(inertBaseProvider());
		editor.registerAtom("TAG", "EXPANDED");
		editor.setText("TAG $al");

		editor.handleInput(LEFT);
		expect(skillRows(editor).length).toBeGreaterThan(0);
		editor.handleInput(TAB);

		expect(editor.getText()).toBe("TAG $alpha");
		expect(editor.getExpandedText()).toBe("EXPANDED $alpha");
		expect(editor.atoms.get("TAG")).toBe("EXPANDED");

		editor.handleNativeEvent({ type: "undo", key: "editor" });
		expect(editor.getText()).toBe("TAG $al");
		expect(editor.getExpandedText()).toBe("EXPANDED $al");
		expect(editor.atoms.get("TAG")).toBe("EXPANDED");
	});

	test("highlighting decorates known skills only and never rewrites the text", () => {
		const editor = createHarness().editor(inertBaseProvider());
		const text = "use $alpha and $notreal";
		const decorate = editor.decorateText;
		expect(typeof decorate).toBe("function");

		const decorated = decorate!(text, { line: 0, startCol: 0, endCol: text.length });
		expect(decorated).not.toBe(text);
		expect(decorated.replace(ANSI_RE, "")).toContain("$notreal");
		expect(/\x1b\[[0-9;?]*m\$alpha/.test(decorated)).toBe(true);
		expect(/\x1b\[[0-9;?]*m\$notreal/.test(decorated)).toBe(false);
	});
});

describe("native menu arbitration", () => {
	/** Drive the editor to `@` -> delete -> `$`, where core still holds the stale @ list. */
	async function nativeDollarEditor(): Promise<FakeEditor> {
		const harness = createHarness();
		const editor = harness.editor(harness.compose(atFileBaseProvider()));
		editor.handleInput("@");
		await until(() => editor.isAutocompleteActive());

		editor.handleInput(BACKSPACE);
		expect(editor.getText()).toBe("");
		editor.handleInput("$");
		expect(editor.getText()).toBe("$");
		return editor;
	}

	/** Same, after core's debounced refresh has rebuilt the native list for the `$` token. */
	async function nativeDollarEditorAfterRefresh(): Promise<FakeEditor> {
		const editor = await nativeDollarEditor();
		await waitForAutocompleteUpdate(editor, () => skillRows(editor).length === 3);
		expect(editor.isAutocompleteActive()).toBe(true);
		return editor;
	}

	test("never renders two skill menus around the debounced native refresh", async () => {
		const editor = await nativeDollarEditor();

		// Native list still holds the stale @ list; the extension's own popup must stay quiet.
		expect(editor.isAutocompleteActive()).toBe(true);
		expect(skillRows(editor).length).toBe(0);

		// Core rebuilds the list for the live `$` token after its private 100 ms debounce.
		// Bun does not mock timers, so await the host's own update event instead of a clock.
		await waitForAutocompleteUpdate(editor, () => skillRows(editor).length === 3);

		// After the debounce the native list refreshes to skill items: exactly one menu.
		expect(editor.isAutocompleteActive()).toBe(true);
		expect(skillRows(editor).length).toBe(3);
	});

	test("Enter before the debounced refresh completes the skill instead of submitting", async () => {
		const editor = await nativeDollarEditor();
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		expect(skillRows(editor).length).toBe(0);

		editor.handleInput(ENTER);

		expect(editor.getText()).toBe("$alpha");
		expect(editor.getCursor()).toEqual({ line: 0, col: 6 });
		expect(submitted).toEqual([]);

		// With the completion accepted, the next Enter submits the prompt.
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["$alpha"]);
	});

	test("accepting from the native menu does not reopen the extension popup", async () => {
		const editor = await nativeDollarEditorAfterRefresh();

		// Type the full name in one burst: the native list is stale, so Tab accepts nothing.
		for (const char of "alpha") editor.handleInput(char);
		expect(editor.getText()).toBe("$alpha");

		editor.handleInput(TAB);
		expect(editor.getText()).toBe("$alpha");
		expect(skillRows(editor).length).toBe(0);
	});

	test("right-arrow native accept does not reopen the extension popup", async () => {
		const editor = await nativeDollarEditorAfterRefresh();

		editor.handleInput(RIGHT);
		expect(editor.getText()).toBe("$alpha");
		expect(skillRows(editor).length).toBe(0);
	});

	test("Escape through the native menu keeps the extension popup closed", async () => {
		const editor = await nativeDollarEditorAfterRefresh();

		editor.handleInput(ESC);
		expect(skillRows(editor).length).toBe(0);
		await until(() => !editor.isShowingAutocomplete());
		expect(skillRows(editor).length).toBe(0);

		// Moving to a new token context may reopen the extension popup.
		editor.handleInput("b");
		expect(skillRows(editor).length).toBeGreaterThan(0);
	});

	test("Escape with a hidden native list leaves normal prompt mode", async () => {
		const harness = createHarness();
		const editor = harness.editor(harness.compose(atFileBaseProvider()));
		// The host wires this callback (input controller); it is what routes ESC away from core.
		editor.onEscape = () => {};

		editor.handleInput("@");
		await until(() => editor.isShowingAutocomplete());

		// Narrowing the @ list to no candidate hides it while core still holds the pending refresh.
		editor.handleInput("z");
		await until(() => editor.isAutocompleteActive() && !editor.isShowingAutocomplete());

		editor.handleInput(ESC);

		expect(editor.isAutocompleteActive()).toBe(false);
		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(skillRows(editor).length).toBe(0);

		// Back in normal prompt mode: Enter submits the untouched text and core clears the draft.
		expect(editor.getText()).toBe("@z");
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["@z"]);
		expect(editor.getText()).toBe("");
	});

	test("pointer activation of a native skill row does not reopen the extension popup", async () => {
		const editor = await nativeDollarEditorAfterRefresh();

		nativeAutocompleteList(editor).handleNativeEvent({ type: "activate", item: "$alpha" });
		await until(() => editor.getText() === "$alpha");

		expect(editor.isAutocompleteActive()).toBe(false);
		expect(skillRows(editor).length).toBe(0);
	});

	test("forced Tab still performs a real file lookup outside $ tokens", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-skills-autocomplete-"));
		temporaryDirs.push(dir);
		writeFileSync(join(dir, "hello-world.txt"), "hi");

		const harness = createHarness();
		const editor = harness.editor(harness.compose(new CombinedAutocompleteProvider([], dir)));

		editor.handleInput("h");
		editor.handleInput("e");
		editor.handleInput("l");
		const shown = waitForAutocompleteUpdate(editor, () => editor.isShowingAutocomplete());
		editor.handleInput(TAB);
		await shown;

		expect(renderText(editor)).toContain("hello-world.txt");

		editor.handleInput(TAB);
		await until(() => editor.getText() === "hello-world.txt");
	});

	test("a superseded slow lookup cannot block a newer completion", async () => {
		const harness = createHarness();
		const requested: string[] = [];
		const slowStarted = deferred<void>();
		const base = inertBaseProvider({
			async getSuggestions(lines, cursorLine, cursorCol, signal) {
				const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
				requested.push(text);
				if (text === "@a") {
					const aborted = Promise.withResolvers<void>();
					if (signal?.aborted) aborted.reject(new Error("aborted"));
					else signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
					slowStarted.resolve();
					await aborted.promise;
					return { items: [{ value: "@a-slow.txt", label: "a-slow.txt" }], prefix: text };
				}
				if (text === "@ab") {
					return { items: [{ value: "@ab.txt", label: "ab.txt" }], prefix: text };
				}
				return null;
			},
		});
		const editor = harness.editor(harness.compose(base));

		editor.handleInput("@");
		await until(() => requested.includes("@"));
		editor.handleInput("a");
		await slowStarted.promise;
		editor.handleInput("b");

		await until(() => editor.isShowingAutocomplete());
		expect(requested).toContain("@ab");

		// The newer lookup owns the popup: accepting it applies the fresh value,
		// and the superseded slow lookup can neither block nor overwrite that.
		editor.handleInput(TAB);
		await until(() => editor.getText() === "@ab.txt");
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["@ab.txt"]);
	});
});