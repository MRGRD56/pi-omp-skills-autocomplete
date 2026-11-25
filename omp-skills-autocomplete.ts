import type { AutocompleteProviderFactory, ComposerDecorator, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { jsx } from "@oh-my-pi/pi-tui";

type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];
type AutocompleteItem = Parameters<AutocompleteProvider["applyCompletion"]>[3];
type Composer = InstanceType<ExtensionAPI["pi"]["InteractiveMode"]>["composer"];

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

const decorateSkills = (text: string, names: ReadonlySet<string>): ReturnType<ComposerDecorator> => {
	const ranges: Array<{ from: number; to: number; s: string }> = [];
	for (const match of text.matchAll(ALL_TOKENS_RE)) {
		if (!names.has(match[2]!)) continue;
		const from = match.index + match[1]!.length;
		ranges.push({ from, to: match.index + match[0].length, s: "accent strong" });
	}
	return ranges;
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
function customMessageText(content: Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[0]["content"]): string {
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

function createSkillProvider(
	current: AutocompleteProvider,
	getCache: () => SkillCache,
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
				const line = lines[cursorLine] ?? "";
				const span = findSkillSpan(line, cursorCol);
				if (!span || span.prefix !== prefix) return { lines, cursorLine, cursorCol };
				const next = [...lines];
				next[cursorLine] = line.slice(0, span.start) + item.value + line.slice(span.end);
				return { lines: next, cursorLine, cursorCol: span.start + item.value.length };
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

	// Preserve the host's synchronous completion paths through the wrapper.
	const syncSlashCompletion = current.trySyncSlashCompletion;
	if (syncSlashCompletion) provider.trySyncSlashCompletion = syncSlashCompletion.bind(current);

	const syncInlineReplace = current.trySyncInlineReplace;
	if (syncInlineReplace) provider.trySyncInlineReplace = syncInlineReplace.bind(current);

	const model = current.trySyncModelMentionCompletion;
	if (model) provider.trySyncModelMentionCompletion = model.bind(current);

	provider.getForceFileSuggestions = async (lines, cursorLine, cursorCol, signal) => {
		if (signal?.aborted) return null;
		const span = findSkillSpan(lines[cursorLine] ?? "", cursorCol);
		if (span) {
			const items = buildSkillItems(getCache().skills, span.query);
			if (items.length > 0) return { items, prefix: span.prefix };
		}
		return current.getForceFileSuggestions?.(lines, cursorLine, cursorCol, signal) ?? null;
	};

	provider.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
		findSkillSpan(lines[cursorLine] ?? "", cursorCol) !== null ||
		current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) !== false;

	return provider;
}

/** OMP 19.2 exposes the composer hooks but not its caret or completion trigger. */
function registerSkillProvider(
	pi: ExtensionAPI,
	register: (factory: AutocompleteProviderFactory) => void,
	factory: AutocompleteProviderFactory,
): Composer {
	const prototype = pi.pi.InteractiveMode.prototype;
	const original = prototype.addAutocompleteProvider;
	let composer: Composer | undefined;
	// Capture the receiver of this synchronous registration only. Never leave a
	// host method patched while the composer is handling input or another plugin.
	prototype.addAutocompleteProvider = function (registered) {
		if (registered === factory) composer = this.composer;
		original.call(this, registered);
	};
	try {
		register(factory);
	} finally {
		prototype.addAutocompleteProvider = original;
	}
	if (!composer) throw new Error("OMP did not register the skill provider on an interactive composer");
	return composer;
}

function installSkillTrigger(pi: ExtensionAPI, composer: Composer, getCache: () => SkillCache): () => void {
	let pendingCaret: number | undefined;
	const getSpan = (text: string, caret: number): SkillSpan | null => {
		const start = caret === 0 ? 0 : text.lastIndexOf("\n", caret - 1) + 1;
		const newline = text.indexOf("\n", caret);
		const span = findSkillSpan(text.slice(start, newline === -1 ? undefined : newline), caret - start);
		return span && { ...span, start: span.start + start, end: span.end + start };
	};
	const removeEdit = composer.addEditListener(() => {
		pendingCaret = undefined;
		if (composer.vimMode() === "normal" || composer.completing()) return;
		const caret = composer.cursor();
		const span = getSpan(composer.text(), caret);
		if (!span || !getCache().skills.some(skill => scoreSkill(span.query, skill.name) > 0)) return;
		const tab = pi.pi.getKeybindings().keysFor("tui.input.tab")[0];
		if (!tab) return;
		pendingCaret = caret;
		composer.handleDraftKey({ id: tab, kind: "press", raw: "\t" });
	});
	const removeKey = composer.addKeyHandler(key => {
		const kb = pi.pi.getKeybindings();
		const pending = pendingCaret;
		pendingCaret = undefined;
		if (composer.completing() || (composer.vimMode() !== null && composer.vimMode() !== "insert")) return false;
		const caret = composer.cursor();
		const tab = kb.matches(key, "tui.input.tab");
		const acceptPending = pending === caret && (kb.matches(key, "tui.input.submit") || key.raw === "\n");
		if (!tab && !acceptPending) return false;
		const span = getSpan(composer.text(), caret);
		const item = span && buildSkillItems(getCache().skills, span.query)[0];
		if (!span || !item) return false;
		composer.replaceRange(span.start, span.end, item.value);
		return true;
	});
	return () => {
		removeEdit();
		removeKey();
	};
}

function findMentionedSkills(text: string, skillNames: ReadonlySet<string>): string[] {
	const matchedSkills = new Set<string>();
	for (const match of text.matchAll(ALL_TOKENS_RE)) {
		const skillName = match[2]!;
		if (skillNames.has(skillName)) matchedSkills.add(skillName);
	}
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
	let disposeComposer: (() => void) | undefined;

	pi.setLabel("$ Skills Autocomplete");

	pi.registerCommand("skills-autocomplete-status", {
		description: "Show $skills autocomplete extension status",
		handler: async (_args, ctx) => {
			const currentCache = refreshCache();
			ctx.ui.notify(`$skills autocomplete loaded; ${currentCache.skills.length} skills available`, "info");
		},
	});

	pi.registerMessageRenderer<RenderDetails>(CUSTOM_TYPE, message => {
		const details = message.details ?? {};
		const displayText = details.displayText ?? customMessageText(message.content);
		return jsx("md", { text: markdownHighlightSkillTokens(displayText, details.skills ?? []) });
	});

	pi.on("session_start", (_event, ctx) => {
		refreshCache();
		const hooks = ctx.ui.composer;
		if (!hooks || disposeComposer) return;

		let active = true;
		const composer = registerSkillProvider(pi, ctx.ui.addAutocompleteProvider, current => {
			if (!active) return current;
			refreshCache();
			return createSkillProvider(current, () => cache);
		});
		const removeTrigger = installSkillTrigger(pi, composer, () => cache);
		const removeDecorator = hooks.addDecorator(text => decorateSkills(text, cache.names));
		disposeComposer = () => {
			active = false;
			removeTrigger();
			removeDecorator();
		};
	});
	pi.on("session_shutdown", () => {
		disposeComposer?.();
		disposeComposer = undefined;
	});

	pi.on("before_agent_start", event => {
		const currentCache = refreshCache();
		const matchedSkills = findMentionedSkills(event.prompt, currentCache.names);
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
