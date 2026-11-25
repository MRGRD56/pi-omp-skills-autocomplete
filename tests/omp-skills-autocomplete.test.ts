import { describe, expect, mock, test } from "bun:test";
import type { AutocompleteProviderFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AutocompleteProvider } from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";
import { getKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { UiNode } from "@oh-my-pi/pi-tui";
// The 19.2.0 package wildcard maps to .ts, but Composer is a .tsx module.
import { Composer } from "../node_modules/@oh-my-pi/pi-coding-agent/src/ui/composer/composer";
import skillsAutocomplete from "../omp-skills-autocomplete";

const SKILL_COMMANDS = [
	{ name: "skill:alpha", description: "Alpha skill", source: "skill" },
	{ name: "skill:beta", description: "Beta skill", source: "skill" },
	{ name: "skill:gamma", description: "Gamma skill", source: "skill" },
	{ name: "skill:decoy", description: "Not a skill", source: "extension" },
];

function baseProvider(overrides: Partial<AutocompleteProvider> = {}): AutocompleteProvider {
	return {
		async getSuggestions() {
			return null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine]!;
			const start = cursorCol - prefix.length;
			const next = [...lines];
			next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
			return { lines: next, cursorLine, cursorCol: start + item.value.length };
		},
		...overrides,
	};
}

type ExtensionApi = Parameters<typeof skillsAutocomplete>[0];
type Handler = (...args: unknown[]) => unknown;

function createHarness(base = baseProvider(), commands = SKILL_COMMANDS) {
	const submitted: string[] = [];
	const composer = new Composer({ onSubmit: text => submitted.push(text) });
	const handlers = new Map<string, Handler[]>();
	const renderers = new Map<string, (message: unknown) => unknown>();
	let provider = base;
	let registrations = 0;
	// Model the synchronous UI bridge with a fresh prototype per harness. The
	// real InteractiveMode implementation requires private session fields.
	class InteractiveMode {
		readonly composer = composer;

		addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
			registrations++;
			provider = factory(provider);
			this.composer.setAutocomplete(provider);
		}
	}
	const mode = new InteractiveMode();
	const original = InteractiveMode.prototype.addAutocompleteProvider;
	const ctx = {
		hasUI: true,
		ui: {
			composer: { addDecorator: composer.addDecorator.bind(composer) },
			addAutocompleteProvider: (factory: AutocompleteProviderFactory) => mode.addAutocompleteProvider(factory),
		},
	};
	const api = {
		setLabel: () => {},
		registerCommand: () => {},
		registerMessageRenderer(type: string, render: (message: unknown) => unknown) {
			renderers.set(type, render);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getCommands: () => commands,
		pi: { InteractiveMode, getKeybindings },
	};
	skillsAutocomplete(api as unknown as ExtensionApi);
	const fire = (event: string, payload: unknown) => (handlers.get(event) ?? []).map(handler => handler(payload, ctx))[0];
	fire("session_start", {});
	expect(registrations).toBe(1);
	expect(InteractiveMode.prototype.addAutocompleteProvider).toBe(original);
	return { composer, provider, submitted, fire, renderers };
}

const RAW_KEY = { tab: "\t", enter: "\r", escape: "\x1b", down: "\x1b[B", right: "\x1b[C" };

function key(composer: Composer, id: keyof typeof RAW_KEY): boolean {
	return composer.field.handlers.onKey!({ id, raw: RAW_KEY[id], kind: "press" });
}

function fieldEdit(composer: Composer, text: string, from = composer.cursor(), to = from, cursor = from + text.length) {
	composer.field.handlers.onEdit!({ type: "edit", key: "editor", from, to, text, cursor, len: composer.text().length });
}

async function until(predicate: () => boolean): Promise<void> {
	// Composer coalesces input and calls these fixture providers in microtasks.
	for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve();
	expect(predicate()).toBe(true);
}

describe("hidden skill context and decoration", () => {
	test("deduplicates known mentions, excludes unknown and non-skill commands, and preserves the prompt", () => {
		const { fire } = createHarness();
		const prompt = "$beta please use $alpha and $beta, $notreal and $decoy";
		const event = { prompt };
		expect(fire("before_agent_start", event)).toEqual({
			message: {
				customType: "skills-autocomplete-prompt",
				content: "($-Mentioned skills: beta, alpha)",
				display: false,
				details: { skills: ["beta", "alpha"] },
			},
		});
		expect(event.prompt).toBe(prompt);
		expect(fire("before_agent_start", { prompt: "use $notreal and $decoy" })).toBeUndefined();
		expect(fire("before_agent_start", { prompt: "plain prompt" })).toBeUndefined();
	});

	test("styles only known skills using UTF-16 draft offsets without rewriting text", () => {
		const { composer } = createHarness();
		const text = "🚀 $alpha and $decoy\n$beta then $notreal";
		composer.setText(text);
		expect((composer.field as UiNode<"editor">).props().decor).toEqual(
			["$alpha", "$beta"].map(token => ({
				from: text.indexOf(token),
				to: text.indexOf(token) + token.length,
				s: "accent strong",
			})),
		);
		expect(composer.text()).toBe(text);
		expect(composer.expandedText()).toBe(text);
	});

	test("older displayed entries use Markdown highlighting without editing their stored content", () => {
		const { renderers } = createHarness();
		const message = { content: "use $alpha and $notreal", details: { skills: ["alpha"] } };
		const render = renderers.get("skills-autocomplete-prompt")!;
		const node = render(message) as UiNode<"md">;
		expect(node.kind).toBe("md");
		expect(node.props().text).toBe("use `$alpha` and \\$notreal");
		expect(message.content).toBe("use $alpha and $notreal");
	});
});

describe("native composer completion", () => {
	test("opens on a valid $ boundary and closes when the token is deleted or becomes invalid", async () => {
		const { composer } = createHarness();
		composer.setText("see (");
		fieldEdit(composer, "$");
		await until(() => composer.completing());
		fieldEdit(composer, "", 5, 6);
		expect(composer.text()).toBe("see (");
		expect(composer.completing()).toBe(false);

		composer.setText("word");
		fieldEdit(composer, "$");
		expect(composer.completing()).toBe(false);

		composer.setText("");
		fieldEdit(composer, "$");
		await until(() => composer.completing());
		fieldEdit(composer, "$");
		expect(composer.text()).toBe("$$");
		expect(composer.completing()).toBe(false);
	});

	test("Tab replaces the entire skill token at a multiline caret and retains its tail", async () => {
		const { composer, submitted } = createHarness();
		composer.setText("first line\nsee $bzzz tail");
		composer.setCursor("first line\nsee $b".length);
		fieldEdit(composer, "e");
		await until(() => composer.completing());
		key(composer, "tab");
		expect(composer.text()).toBe("first line\nsee $beta tail");
		expect(composer.cursor()).toBe("first line\nsee $beta".length);
		expect(composer.completing()).toBe(false);
		expect(submitted).toEqual([]);
	});

	test("a single Tab completes at a caret moved into an existing token", () => {
		const { composer } = createHarness();
		composer.setText("see $al tail");
		fieldEdit(composer, "", composer.cursor(), composer.cursor(), "see $a".length);
		key(composer, "tab");
		expect(composer.completing()).toBe(false);
		expect(composer.text()).toBe("see $alpha tail");
		expect(composer.cursor()).toBe("see $alpha".length);
	});

	test("Down selects the next row and Enter accepts before the next Enter submits", async () => {
		const { composer, submitted } = createHarness();
		fieldEdit(composer, "$");
		await until(() => composer.completing());
		key(composer, "down");
		key(composer, "enter");
		expect(composer.text()).toBe("$beta");
		expect(composer.completing()).toBe(false);
		expect(submitted).toEqual([]);
		key(composer, "enter");
		expect(submitted).toEqual(["$beta"]);
	});

	test("Enter immediately after typing $ completes instead of submitting", async () => {
		const { composer, submitted } = createHarness();
		fieldEdit(composer, "$");
		key(composer, "enter");
		await until(() => composer.text() === "$alpha");
		expect(submitted).toEqual([]);
		key(composer, "enter");
		expect(submitted).toEqual(["$alpha"]);
	});

	test("an identical accept closes the popup without submitting", async () => {
		const { composer, submitted } = createHarness();
		fieldEdit(composer, "$beta");
		await until(() => composer.completing());
		key(composer, "enter");
		fieldEdit(composer, ""); // Caret-only event without movement.
		expect(composer.text()).toBe("$beta");
		expect(composer.completing()).toBe(false);
		expect(submitted).toEqual([]);
		key(composer, "enter");
		expect(submitted).toEqual(["$beta"]);
	});

	test("Escape dismisses the popup without changing the draft; an edit can reopen it", async () => {
		const { composer } = createHarness();
		fieldEdit(composer, "$");
		await until(() => composer.completing());
		key(composer, "escape");
		expect(composer.text()).toBe("$");
		expect(composer.completing()).toBe(false);
		fieldEdit(composer, "b");
		await until(() => composer.completing());
		key(composer, "right");
		expect(composer.text()).toBe("$beta");
		expect(composer.completing()).toBe(false);
	});

	test("activating a native row applies it without reopening the popup", async () => {
		const { composer } = createHarness();
		fieldEdit(composer, "$");
		await until(() => composer.completing());
		const overlay = composer.node.children().find(node => node.kind === "overlay");
		const list = overlay?.children()[0]?.children()[0];
		expect(list?.kind).toBe("list");
		list!.handlers.onActivate!("$gamma", { type: "activate", key: "complete/list", item: "$gamma" });
		expect(composer.text()).toBe("$gamma");
		expect(composer.completing()).toBe(false);
	});

	test("native completion is a single undo step and keeps the attachment and trailing text", async () => {
		const { composer } = createHarness();
		composer.insertAtom("TAG", "EXPANDED");
		composer.insertText("$a tail");
		composer.setCursor("TAG $a".length);
		fieldEdit(composer, "l");
		const before = composer.text();
		await until(() => composer.completing());
		key(composer, "tab");
		expect(composer.text()).toBe(before.replace("$al", "$alpha"));
		expect(composer.expandedText()).toBe("EXPANDED $alpha tail");
		composer.undo();
		expect(composer.text()).toBe(before);
		expect(composer.expandedText()).toBe("EXPANDED $al tail");
	});
});

describe("the stacked provider", () => {
	test("ranks exact, prefix, substring and subsequence skill matches in that order", async () => {
		const commands = ["axby", "cab", "about", "ab", "unmatched"].map(name => ({
			name: `skill:${name}`,
			description: `Description for ${name}`,
			source: "skill",
		}));
		const { provider } = createHarness(baseProvider(), commands);
		const result = await provider.getSuggestions(["see ($ab"], 0, 8);
		expect(result?.prefix).toBe("$ab");
		expect(result?.items.map(item => item.value)).toEqual(["$ab", "$about", "$cab", "$axby"]);
		expect(result?.items[0]).toMatchObject({ label: "$ab", description: "Description for ab" });
	});

	test("unmatched skills stay literal and inline hints do not duplicate a token suffix", async () => {
		const { provider, composer } = createHarness();
		expect(await provider.getSuggestions(["$zzz"], 0, 4)).toBeNull();
		expect(provider.getInlineHint?.(["$al"], 0, 3)).toBe("pha");
		expect(provider.getInlineHint?.(["$al"], 0, 2)).toBeNull();
		fieldEdit(composer, "$zzz");
		key(composer, "tab");
		expect(composer.text()).toBe("$zzz");
		expect(composer.completing()).toBe(false);
	});

	test("forwards non-skill suggestions, partial callbacks, cancellation, and completion to the base", async () => {
		const file = { value: "@file.txt", label: "file.txt" };
		const result = { items: [file], prefix: "@f" };
		const getSuggestions = mock<AutocompleteProvider["getSuggestions"]>(async (_lines, _line, _col, _signal, partial) => {
			partial?.(result);
			return result;
		});
		const applyCompletion = mock(baseProvider().applyCompletion);
		const { provider } = createHarness(baseProvider({ getSuggestions, applyCompletion }));
		const lines = ["first line", "see @f tail"];
		const { signal } = new AbortController();
		const partial = mock(() => {});
		expect(await provider.getSuggestions(lines, 1, 6, signal, partial)).toEqual(result);
		expect(getSuggestions).toHaveBeenCalledWith(lines, 1, 6, signal, partial);
		expect(partial).toHaveBeenCalledWith(result);
		expect(await provider.getSuggestions(["$"], 0, 1, AbortSignal.abort())).toBeNull();
		expect(getSuggestions).toHaveBeenCalledTimes(1);
		expect(provider.applyCompletion(lines, 1, 6, file, "@f")).toEqual({
			lines: ["first line", "see @file.txt tail"],
			cursorLine: 1,
			cursorCol: 13,
		});
		expect(applyCompletion).toHaveBeenCalledWith(lines, 1, 6, file, "@f");
	});

	test("preserves optional slash and inline tools without inventing them on providers that lack them", () => {
		const missing = createHarness().provider;
		expect(missing.trySyncSlashCompletion).toBeUndefined();
		expect(missing.trySyncInlineReplace).toBeUndefined();
		expect(missing.trySyncModelMentionCompletion).toBeUndefined();

		const slash = { items: [{ value: "/compact" }], prefix: "/c" };
		const replace = { replaceLen: 2, insert: "→" };
		const base = baseProvider({
			trySyncSlashCompletion(before) {
				return this === base && before === "/c" ? slash : null;
			},
			trySyncInlineReplace(before) {
				return this === base && before.endsWith("->") ? replace : null;
			},
		});
		const { provider } = createHarness(base);
		expect(provider.trySyncSlashCompletion?.("/c")).toEqual(slash);
		expect(provider.trySyncInlineReplace?.("go ->")).toEqual(replace);
	});

	test("keeps an existing ^ model provider and forced file completion working through the composer", async () => {
		const trySyncModelMentionCompletion = mock<NonNullable<AutocompleteProvider["trySyncModelMentionCompletion"]>>(
			() => ({ kind: "matched", suggestions: { prefix: "^", items: [{ value: "^demo-model" }] } }),
		);
		const getForceFileSuggestions = mock<NonNullable<AutocompleteProvider["getForceFileSuggestions"]>>(async () => ({
			prefix: "hel",
			items: [{ value: "hello-world.txt" }],
		}));
		const { composer } = createHarness(baseProvider({ trySyncModelMentionCompletion, getForceFileSuggestions }));
		fieldEdit(composer, "^");
		expect(trySyncModelMentionCompletion).toHaveBeenCalledWith(["^"], 0, 1);
		expect(composer.completing()).toBe(true);
		key(composer, "tab");
		expect(composer.text()).toBe("^demo-model");

		composer.setText("hel");
		key(composer, "tab");
		await until(() => composer.completing());
		expect(getForceFileSuggestions).toHaveBeenCalledTimes(1);
		key(composer, "tab");
		expect(composer.text()).toBe("hello-world.txt");
	});
});