import type { AutocompleteItem, AutocompleteProvider, EditorTheme, KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { SelectList } from "@oh-my-pi/pi-tui";
import type { CustomEditor, CustomMessageContent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const CUSTOM_TYPE = "skills-autocomplete-prompt";
const SKILL_PREFIX = "skill:";
const TOKEN_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]*)$/;
const ALL_TOKENS_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g;
const TOKEN_CHAR_RE = /[A-Za-z0-9_-]/;

type SkillInfo = {
	name: string;
	description?: string;
};

type SkillCache = {
	skills: SkillInfo[];
	names: Set<string>;
};

type RenderDetails = {
	displayText?: string;
	skills?: string[];
};

type EditorDecorationContext = {
	line: number;
	startCol: number;
	endCol: number;
};

// Structural slice of the injected OMP theme (`ctx.ui.theme`) the composer
// decoration needs, kept local so the extension does not widen its host types.
type DecorationTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

// The wrapped provider reports every applied $-completion here. Core invokes
// `onApplied` after installing the new text, which is the only reliable signal
// for acceptance paths that never reach this editor's `handleInput` (pointer
// selection) and for acceptances that leave the text unchanged.
type SkillSignals = {
	notifyNativeSkillApplied?: () => void;
};

// The `$token` under the caret: `start`/`end` cover both halves of the token
// (a caret inside the token still replaces the whole thing), `prefix` is only
// the text before the caret, which is what the autocomplete host matches on.
type SkillSpan = {
	start: number;
	end: number;
	query: string;
	prefix: string;
};


function getSkillNameSet(skills: readonly (SkillInfo | string)[]): Set<string> {
	return new Set(skills.map(skill => (typeof skill === "string" ? skill : skill.name)));
}

function highlightSkillTokens(
	text: string,
	skillNames: ReadonlySet<string>,
	getTheme: () => DecorationTheme,
): string {
	const theme = getTheme();
	return text.replace(/(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g, (whole, lead: string, skillName: string) => {
		if (!skillNames.has(skillName)) return whole;
		return `${lead}${theme.bold(theme.fg("accent", `$${skillName}`))}`;
	});
}

function markdownHighlightSkillTokens(text: string, skills: readonly (SkillInfo | string)[]): string {
	const skillNames = getSkillNameSet(skills);
	return text.replace(/(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g, (whole, lead: string, skillName: string, offset: number) => {
		const tokenStart = offset + lead.length;
		const tokenEnd = tokenStart + skillName.length + 1;
		if (text[tokenStart - 1] === "`" && text[tokenEnd] === "`") return whole;

		if (!skillNames.has(skillName)) return `${lead}\\$${skillName}`;
		return `${lead}\`$${skillName}\``;
	});
}

/** Text of a custom message's content; mirrors core's own extraction (text parts joined by newlines). */
function customMessageText(content: CustomMessageContent): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

function getSkills(pi: ExtensionAPI): SkillInfo[] {
	return pi
		.getCommands()
		.filter(command => command.source === "skill" && command.name.startsWith(SKILL_PREFIX))
		.map(command => ({
			name: command.name.slice(SKILL_PREFIX.length),
			description: command.description,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function buildSkillCache(pi: ExtensionAPI): SkillCache {
	const skills = getSkills(pi);
	return { skills, names: new Set(skills.map(skill => skill.name)) };
}

function scoreSkill(query: string, name: string): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const n = name.toLowerCase();
	if (n === q) return 1000;
	if (n.startsWith(q)) return 900 - Math.min(n.length, 100);
	if (n.includes(q)) return 600 - n.indexOf(q);

	let qi = 0;
	let gaps = 0;
	let last = -1;
	for (let i = 0; i < n.length && qi < q.length; i += 1) {
		if (n[i] === q[qi]) {
			if (last >= 0 && i - last > 1) gaps += 1;
			last = i;
			qi += 1;
		}
	}
	return qi === q.length ? Math.max(1, 300 - gaps * 10 - n.length) : 0;
}

function findSkillToken(textBeforeCursor: string): { prefix: string; query: string } | null {
	if (textBeforeCursor.endsWith("$ ") || textBeforeCursor.endsWith("$$ ")) return null;
	const match = textBeforeCursor.match(TOKEN_RE);
	if (!match) return null;
	const query = match[2] ?? "";
	return { prefix: `$${query}`, query };
}

/**
 * Locate the active `$token` around `cursorCol` on one line. The left half is
 * matched with the shared token grammar; the right half is scanned so a caret
 * placed inside `$skill` still resolves the complete token.
 */
function findSkillSpan(line: string, cursorCol: number): SkillSpan | null {
	const token = findSkillToken(line.slice(0, cursorCol));
	if (!token) return null;
	const start = cursorCol - token.prefix.length;
	let end = cursorCol;
	while (end < line.length && TOKEN_CHAR_RE.test(line[end] ?? "")) end += 1;
	return { start, end, query: token.query, prefix: token.prefix };
}

function buildSkillItems(skills: SkillInfo[], query: string): AutocompleteItem[] {
	return skills
		.map(skill => ({ skill, score: scoreSkill(query, skill.name) }))
		.filter(entry => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.slice(0, 30)
		.map(({ skill }) => ({
			value: `$${skill.name}`,
			label: `$${skill.name}`,
			description: skill.description,
		}));
}

/** UTF-16 offset of `[line, col)` in the buffer text (`lines` joined by `\n`). */
function textOffset(lines: readonly string[], line: number, col: number): number {
	let offset = 0;
	for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
	return offset + col;
}

function createSkillProvider(
	current: AutocompleteProvider,
	getCache: () => SkillCache,
	onSkillApplied: () => void,
): AutocompleteProvider {
	const provider: AutocompleteProvider = {
		async getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
			if (signal?.aborted) return null;
			const span = findSkillSpan(lines[cursorLine] ?? "", cursorCol);
			if (span) {
				const items = buildSkillItems(getCache().skills, span.query);
				if (items.length > 0 && !signal?.aborted) return { items, prefix: span.prefix };
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$") && item.value.startsWith("$")) {
				// A stale accept (the buffer moved on since the list was built, e.g.
				// a pointer click) leaves the prompt untouched: rewriting characters
				// that are no longer this token would corrupt unrelated text.
				const span = findSkillSpan(lines[cursorLine] ?? "", cursorCol);
				if (!span) return { lines, cursorLine, cursorCol };
				const line = lines[cursorLine] ?? "";
				const next = [...lines];
				next[cursorLine] = line.slice(0, span.start) + item.value + line.slice(span.end);
				return {
					lines: next,
					cursorLine,
					cursorCol: span.start + item.value.length,
					onApplied: onSkillApplied,
				};
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		getInlineHint(lines, cursorLine, cursorCol) {
			const span = findSkillSpan(lines[cursorLine] ?? "", cursorCol);
			if (!span) return current.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
			// Ghost text only makes sense at the token tail; a caret inside the
			// token would duplicate the characters that sit after it.
			if (span.end !== cursorCol) return null;

			const first = buildSkillItems(getCache().skills, span.query)[0];
			if (!first?.value.startsWith(span.prefix) || first.value === span.prefix) return null;
			return first.value.slice(span.prefix.length);
		},
	};

	// Optional host hooks stay absent unless the wrapped provider has them, so
	// stacking does not invent capabilities core never sees on the base.
	const syncSlashCompletion = current.trySyncSlashCompletion;
	if (syncSlashCompletion) provider.trySyncSlashCompletion = syncSlashCompletion.bind(current);

	const syncInlineReplace = current.trySyncInlineReplace;
	if (syncInlineReplace) provider.trySyncInlineReplace = syncInlineReplace.bind(current);

	const forceFileSuggestions = current.getForceFileSuggestions;
	if (forceFileSuggestions) {
		const force = forceFileSuggestions.bind(current);
		provider.getForceFileSuggestions = async (lines, cursorLine, cursorCol, signal) => {
			if (signal?.aborted) return null;
			const span = findSkillSpan(lines[cursorLine] ?? "", cursorCol);
			if (span) {
				const items = buildSkillItems(getCache().skills, span.query);
				if (items.length > 0) return { items, prefix: span.prefix };
			}
			return force(lines, cursorLine, cursorCol, signal);
		};
	}

	const shouldTriggerFileCompletion = current.shouldTriggerFileCompletion;
	if (shouldTriggerFileCompletion) {
		const should = shouldTriggerFileCompletion.bind(current);
		provider.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
			findSkillSpan(lines[cursorLine] ?? "", cursorCol) !== null || should(lines, cursorLine, cursorCol);
	}

	return provider;
}

function createSkillsAutocompleteEditor(BaseEditor: typeof CustomEditor) {
	return class SkillsAutocompleteEditor extends BaseEditor {
		#keybindings: KeybindingsManager;
		#editorTheme: EditorTheme;
		#getCache: () => SkillCache;
		#getTheme: () => DecorationTheme;
		#baseDecorateText: (text: string, context: EditorDecorationContext) => string;
		#ownList: SelectList | undefined;
		#ownSignature = "";
		#suppressedSignature = "";
		#nativeSkillApplied = false;

		constructor(
			tui: TUI,
			theme: EditorTheme,
			keybindings: KeybindingsManager,
			getCache: () => SkillCache,
			getTheme: () => DecorationTheme,
			signals: SkillSignals,
		) {
			super(theme);
			this.tui = tui;
			this.#editorTheme = theme;
			this.#keybindings = keybindings;
			this.#getCache = getCache;
			this.#getTheme = getTheme;
			signals.notifyNativeSkillApplied = () => this.#noteNativeSkillApplied();
			this.#baseDecorateText = this.decorateText.bind(this);
			// `context` stays optional for OMP 17.x hosts that call the decorator
			// with text only; the value itself is forwarded unchanged.
			this.decorateText = (text: string, context?: EditorDecorationContext) =>
				highlightSkillTokens(
					this.#baseDecorateText(text, context as EditorDecorationContext),
					this.#getCache().names,
					this.#getTheme,
				);
		}

		override render(width: number): readonly string[] {
			const lines = [...super.render(width)];
			// Exactly one visible popup: native autocomplete owns the screen while
			// it is active, the extension list shows only when it is not.
			if (this.#ownList && !this.isAutocompleteActive()) {
				lines.push(...this.#ownList.render(width));
			}
			return lines;
		}

		override handleInput(data: string): void {
			const kb = this.#keybindings;

			// Native autocomplete owns the input while it is active (its list may be
			// narrowed to no candidate but still pending a debounced refresh). Keep a
			// prepared extension list in sync so it can surface if native cancels.
			const submitKey = kb.matches(data, "tui.input.submit");
			const acceptKey =
				kb.matches(data, "tui.input.tab") || submitKey || kb.matches(data, "tui.select.confirm") || data === "\n";

			if (this.isAutocompleteActive()) {
				this.#refreshOwnList(false);
				const cancels = kb.matches(data, "tui.select.cancel");
				const canComplete = acceptKey && this.#ownList !== undefined;
				const beforeRevision = this.textRevision;
				this.#nativeSkillApplied = false;
				// A bare LF is Shift+Enter (new line), never the submit path, so it
				// must not arm the submit guard.
				const blockSubmit = canComplete && submitKey && data !== "\n";
				if (blockSubmit) this.disableSubmit = true;
				try {
					// Escape has to reach the base pipeline: CustomEditor turns Escape
					// on a hidden native list into the app interrupt and would leave the
					// native state (and its pending refresh) alive.
					if (cancels) super.handleDraftEdit(data);
					else super.handleInput(data);
				} finally {
					if (blockSubmit) this.disableSubmit = false;
				}

				// The wrapped provider applied a skill: it already dismissed the
				// completed context, so native acceptance cannot reopen our list.
				if (this.#nativeSkillApplied) return;

				// Core cancelled a stale native menu without applying anything. Honour
				// the key press by completing the prepared candidate instead of
				// dropping it (the first Enter completes rather than submitting).
				if (
					canComplete &&
					this.#ownList &&
					!this.isAutocompleteActive() &&
					this.textRevision === beforeRevision
				) {
					this.#ownList.handleInput("\n");
					if (this.#ownList) {
						this.#clearOwn();
						this.#requestRender();
					}
					return;
				}

				if (this.#refreshOwnList(cancels)) this.#requestRender();
				return;
			}

			if (this.#ownList) {
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.pageUp") ||
					kb.matches(data, "tui.select.pageDown")
				) {
					this.#ownList.handleInput(data);
					this.#requestRender();
					return;
				}

				if (acceptKey) {
					// Accept the selection in place; Enter must not submit the prompt.
					this.#ownList.handleInput("\n");
					if (this.#ownList) {
						this.#clearOwn();
						this.#requestRender();
					}
					return;
				}

				if (kb.matches(data, "tui.select.cancel")) {
					this.#refreshOwnList(true);
					this.#requestRender();
					return;
				}
			}

			super.handleInput(data);
			if (this.#refreshOwnList(false)) this.#requestRender();
		}

		/**
		 * The wrapped provider installed a $-completion: core calls this after the
		 * new text is in place. Pin the completed context as dismissed regardless of
		 * which key accepted it (Enter, Tab, Right Arrow, pointer click) and even
		 * when the accepted value left the text unchanged.
		 */
		#noteNativeSkillApplied(): void {
			this.#nativeSkillApplied = true;
			if (this.#refreshOwnList(true)) this.#requestRender();
		}

		/**
		 * Recompute the extension list for the `$token` under the caret. Read-only
		 * with respect to the popup: it either rebuilds the hidden/visible list or
		 * clears it. `suppress` pins the current context as dismissed. The context
		 * identity is the buffer revision plus the caret and the token span, so it
		 * costs a counter read and cannot survive an edit, undo or caret move.
		 */
		#refreshOwnList(suppress: boolean): boolean {
			const lines = this.getLines();
			const { line, col } = this.getCursor();
			const span = findSkillSpan(lines[line] ?? "", col);
			if (!span) {
				this.#suppressedSignature = "";
				return this.#clearOwn();
			}

			const signature = `${this.textRevision}\u0000${line}\u0000${col}\u0000${span.start}\u0000${span.end}`;
			if (suppress) {
				this.#suppressedSignature = signature;
				return this.#clearOwn();
			}
			if (signature === this.#suppressedSignature) return this.#clearOwn();
			// Any other context (edit, undo, caret move) expires the dismissal for
			// good instead of leaving a stale pin that could hide a later popup.
			this.#suppressedSignature = "";

			const items = buildSkillItems(this.#getCache().skills, span.query);
			if (items.length === 0) return this.#clearOwn();

			const listSignature = `${span.start}\u0000${span.end}\u0000${items.map(item => item.value).join("\u0000")}`;
			if (this.#ownList && listSignature === this.#ownSignature) return false;

			this.#ownSignature = listSignature;
			this.#ownList = new SelectList(items, 8, this.#editorTheme.selectList, { overflowSearch: false });
			this.#ownList.onSelect = item => this.#applyOwnCompletion(item);
			return true;
		}

		#clearOwn(): boolean {
			if (!this.#ownList && !this.#ownSignature) return false;
			this.#ownList = undefined;
			this.#ownSignature = "";
			return true;
		}

		/** Complete the prepared selection as one undoable host edit over the whole token. */
		#applyOwnCompletion(item: AutocompleteItem): void {
			const lines = this.getLines();
			const { line, col } = this.getCursor();
			const span = findSkillSpan(lines[line] ?? "", col);
			const before = this.getText();
			if (span) {
				const from = textOffset(lines, line, span.start);
				this.applyHostEdit({
					from,
					to: textOffset(lines, line, span.end),
					text: item.value,
					cursor: from + item.value.length,
					len: before.length,
				});
			}

			// Pin the resulting context (even when the token already equalled the
			// accepted value, so no edit was needed) — the completed token must not
			// reopen until the cursor or text leaves it.
			this.#refreshOwnList(true);
			this.#requestRender();
		}

		#requestRender(): void {
			this.invalidate();
			if (this.onAutocompleteUpdate) this.onAutocompleteUpdate();
			else this.tui?.requestRender(true);
		}
	};
}

function findMentionedSkills(text: string, skills: readonly SkillInfo[]): string[] {
	const skillNames = new Set(skills.map(skill => skill.name));
	const matchedSkills = new Set<string>();
	text.replace(ALL_TOKENS_RE, (_whole, _lead: string, skillName: string) => {
		if (skillNames.has(skillName)) matchedSkills.add(skillName);
		return "";
	});
	return [...matchedSkills];
}

function formatMentionedSkillsContext(matchedSkills: readonly string[]): string | null {
	if (matchedSkills.length === 0) return null;
	return `($-Mentioned skills: ${matchedSkills.join(", ")})`;
}

export default function skillsAutocomplete(pi: ExtensionAPI): void {
	let cache: SkillCache = { skills: [], names: new Set() };
	const refreshCache = (): SkillCache => {
		cache = buildSkillCache(pi);
		return cache;
	};
	const SkillsAutocompleteEditor = createSkillsAutocompleteEditor(pi.pi.CustomEditor);
	const skillSignals: SkillSignals = {};
	let editorInstalled = false;

	pi.setLabel("$ Skills Autocomplete");

	pi.registerCommand("skills-autocomplete-status", {
		description: "Show $skills autocomplete extension status",
		handler: async (_args, ctx) => {
			const currentCache = refreshCache();
			ctx.ui.notify(`$skills autocomplete loaded; ${currentCache.skills.length} skills available`, "info");
		},
	});

	pi.registerMessageRenderer<RenderDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		pi.pi.setThemeInstance(theme);
		const details = message.details ?? {};
		const displayText = details.displayText ?? customMessageText(message.content);
		return new pi.pi.UserMessageComponent(markdownHighlightSkillTokens(displayText, details.skills ?? []));
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		refreshCache();
		if (!ctx.hasUI || editorInstalled) return;

		editorInstalled = true;
		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			pi.pi.setThemeInstance(ctx.ui.theme);
			const editor = new SkillsAutocompleteEditor(
				tui,
				theme,
				keybindings,
				() => cache,
				() => ctx.ui.theme,
				skillSignals,
			);
			editor.setUseTerminalCursor(tui.getShowHardwareCursor());
			return editor;
		});
		// Installed after the editor so the host rebuilds the wrapped provider onto it.
		ctx.ui.addAutocompleteProvider(current => {
			refreshCache();
			return createSkillProvider(current, () => cache, () => skillSignals.notifyNativeSkillApplied?.());
		});
	});

	pi.on("before_agent_start", event => {
		const currentCache = refreshCache();
		const matchedSkills = findMentionedSkills(event.prompt, currentCache.skills);
		const content = formatMentionedSkillsContext(matchedSkills);
		if (!content) return;

		return {
			message: {
				customType: CUSTOM_TYPE,
				content,
				display: false,
				details: { skills: matchedSkills },
			},
		};
	});
}
