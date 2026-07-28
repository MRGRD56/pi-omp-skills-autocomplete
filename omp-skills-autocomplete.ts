import type { AutocompleteItem, AutocompleteProvider, EditorTheme, KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { SelectList, getKeybindings } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const CUSTOM_TYPE = "skills-autocomplete-prompt";
const SKILL_PREFIX = "skill:";
const TOKEN_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]*)$/;
const ALL_TOKENS_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g;

type SkillInfo = {
	name: string;
	description?: string;
};

type RenderDetails = {
	displayText?: string;
	skills?: string[];
};


function getSkillNameSet(skills: readonly (SkillInfo | string)[]): Set<string> {
	return new Set(skills.map(skill => (typeof skill === "string" ? skill : skill.name)));
}

function highlightSkillTokens(text: string, skills: readonly (SkillInfo | string)[]): string {
	const skillNames = getSkillNameSet(skills);
	return text.replace(/(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g, (whole, lead: string, skillName: string) => {
		if (!skillNames.has(skillName)) return whole;
		return `${lead}\x1b[1m\x1b[36m$${skillName}\x1b[39m\x1b[22m`;
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

function getSkills(pi: ExtensionAPI): SkillInfo[] {
	return pi
		.getCommands()
		.filter(command => command.name.startsWith(SKILL_PREFIX))
		.map(command => ({
			name: command.name.slice(SKILL_PREFIX.length),
			description: command.description,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
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

function applyTextCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const next = [...lines];
	const line = next[cursorLine] ?? "";
	const before = line.slice(0, cursorCol);
	const after = line.slice(cursorCol);
	const insert = item.value;
	const start = Math.max(0, before.length - prefix.length);
	next[cursorLine] = before.slice(0, start) + insert + after;
	return { lines: next, cursorLine, cursorCol: start + insert.length };
}

function createSkillProvider(current: AutocompleteProvider, getCurrentSkills: () => SkillInfo[]): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const token = findSkillToken(line.slice(0, cursorCol));
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol);

			const items = buildSkillItems(getCurrentSkills(), token.query);
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol);
			return { items, prefix: token.prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$") && item.value.startsWith("$")) {
				return applyTextCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		getInlineHint(lines, cursorLine, cursorCol) {
			const line = lines[cursorLine] ?? "";
			const token = findSkillToken(line.slice(0, cursorCol));
			if (!token) return current.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;

			const first = buildSkillItems(getCurrentSkills(), token.query)[0];
			if (!first?.value.startsWith(token.prefix) || first.value === token.prefix) return null;
			return first.value.slice(token.prefix.length);
		},

		trySyncSlashCompletion: current.trySyncSlashCompletion?.bind(current),
		trySyncInlineReplace: current.trySyncInlineReplace?.bind(current),
	};
}

class SkillsAutocompleteEditor extends CustomEditor {
	#providerFactory: (current: AutocompleteProvider) => AutocompleteProvider;
	#getCurrentSkills: () => SkillInfo[];
	#baseDecorateText: (text: string) => string;
	#popupList: SelectList | undefined;
	#popupPrefix = "";
	#popupSignature = "";
	#suppressedPopupText = "";

	constructor(
		private readonly tui: TUI,
		private readonly theme: EditorTheme,
		providerFactory: (current: AutocompleteProvider) => AutocompleteProvider,
		getCurrentSkills: () => SkillInfo[],
	) {
		super(theme);
		this.#providerFactory = providerFactory;
		this.#getCurrentSkills = getCurrentSkills;
		this.#baseDecorateText = this.decorateText.bind(this);
		this.decorateText = (text: string) => highlightSkillTokens(this.#baseDecorateText(text), this.#getCurrentSkills());
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(this.#providerFactory(provider));
	}

	override render(width: number): readonly string[] {
		const lines = [...super.render(width)];
		if (this.#popupList) {
			lines.push(...this.#popupList.render(width));
		}
		return lines;
	}

	override handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.#popupList && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
			this.#popupList.handleInput(data);
			this.tui.requestRender(true);
			return;
		}

		if (this.#popupList && (kb.matches(data, "tui.input.tab") || kb.matches(data, "tui.select.confirm") || data === "\n")) {
			this.#popupList.handleInput("\n");
			return;
		}

		if (this.#popupList && kb.matches(data, "tui.select.cancel")) {
			this.#suppressedPopupText = this.getText();
			this.#clearPopup();
			this.invalidate();
			this.tui.requestRender(true);
			return;
		}

		super.handleInput(data);
		if (this.#syncPopup()) {
			this.invalidate();
			this.tui.requestRender(true);
		}
	}

	#syncPopup(): boolean {
		const text = this.getText();
		const token = findSkillToken(text);
		if (!token) {
			return this.#clearPopup();
		}
		if (text === this.#suppressedPopupText) return this.#clearPopup();
		if (this.#suppressedPopupText && text !== this.#suppressedPopupText) this.#suppressedPopupText = "";

		const items = buildSkillItems(this.#getCurrentSkills(), token.query);
		if (items.length === 0) {
			return this.#clearPopup();
		}

		const signature = `${token.prefix}\u0000${items.map(item => item.value).join("\u0000")}`;
		if (signature === this.#popupSignature && this.#popupList) return false;

		this.#popupPrefix = token.prefix;
		this.#popupSignature = signature;
		this.#popupList = new SelectList(items, 8, this.theme.selectList, { overflowSearch: false });
		this.#popupList.onSelect = item => this.#applyPopupCompletion(item);
		return true;
	}

	#clearPopup(): boolean {
		if (!this.#popupList && !this.#popupPrefix && !this.#popupSignature) return false;
		this.#popupList = undefined;
		this.#popupPrefix = "";
		this.#popupSignature = "";
		return true;
	}

	#applyPopupCompletion(item: AutocompleteItem): void {
		const token = findSkillToken(this.getText());
		if (token) {
			const text = this.getText();
			this.setText(text.slice(0, -token.prefix.length) + item.value);
		}
		this.#suppressedPopupText = this.getText();
		this.#clearPopup();
		this.invalidate();
		this.tui.requestRender(true);
	}
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
	let skills: SkillInfo[] = [];
	const refreshSkills = () => {
		skills = getSkills(pi);
		return skills;
	};

	pi.setLabel("$ Skills Autocomplete");

	pi.registerCommand("skills-autocomplete-status", {
		description: "Show $skills autocomplete extension status",
		handler: async (_args, ctx) => {
			const currentSkills = refreshSkills();
			ctx.ui.notify(`$skills autocomplete loaded; ${currentSkills.length} skills available`, "info");
		},
	});

	pi.registerMessageRenderer<RenderDetails>(CUSTOM_TYPE, (message, _options, theme) => {
		setThemeInstance(theme);
		const details = message.details ?? {};
		const displayText = details.displayText ?? message.content;
		return new UserMessageComponent(markdownHighlightSkillTokens(displayText, details.skills ?? []));
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		refreshSkills();
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, _keybindings: KeybindingsManager) => {
			setThemeInstance(ctx.ui.theme);
			const editor = new SkillsAutocompleteEditor(tui, theme, current => createSkillProvider(current, refreshSkills), refreshSkills);
			editor.setUseTerminalCursor(tui.getShowHardwareCursor());
			return editor;
		});
	});

	pi.on("before_agent_start", event => {
		const currentSkills = refreshSkills();
		const matchedSkills = findMentionedSkills(event.prompt, currentSkills);
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
