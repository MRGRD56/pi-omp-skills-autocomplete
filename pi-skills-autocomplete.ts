import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "skills-autocomplete-prompt";
const SKILL_PREFIX = "skill:";
const TOKEN_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]*)$/;
const ALL_TOKENS_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g;

export type SkillInfo = {
	name: string;
	description?: string;
};

export function getSkills(pi: Pick<ExtensionAPI, "getCommands">): SkillInfo[] {
	return pi
		.getCommands()
		.filter(command => command.source === "skill")
		.map(command => ({
			name: command.name.startsWith(SKILL_PREFIX) ? command.name.slice(SKILL_PREFIX.length) : command.name,
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

export function findSkillToken(textBeforeCursor: string): { prefix: string; query: string } | null {
	if (textBeforeCursor.endsWith("$ ") || textBeforeCursor.endsWith("$$ ")) return null;
	const match = textBeforeCursor.match(TOKEN_RE);
	if (!match) return null;
	const query = match[2] ?? "";
	return { prefix: `$${query}`, query };
}

export function buildSkillItems(skills: SkillInfo[], query: string): AutocompleteItem[] {
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

export function applyTextCompletion(
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

export function findMentionedSkills(text: string, skills: readonly SkillInfo[]): string[] {
	const skillNames = new Set(skills.map(skill => skill.name));
	const matchedSkills = new Set<string>();
	text.replace(ALL_TOKENS_RE, (_whole, _lead: string, skillName: string) => {
		if (skillNames.has(skillName)) matchedSkills.add(skillName);
		return "";
	});
	return [...matchedSkills];
}

export function formatMentionedSkillsContext(matchedSkills: readonly string[]): string | null {
	if (matchedSkills.length === 0) return null;
	return `($-Mentioned skills: ${matchedSkills.join(", ")})`;
}

export function createSkillProvider(current: AutocompleteProvider, getCurrentSkills: () => SkillInfo[]): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const token = findSkillToken(line.slice(0, cursorCol));
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const items = buildSkillItems(getCurrentSkills(), token.query);
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: token.prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (prefix.startsWith("$") && item.value.startsWith("$")) {
				return applyTextCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function skillsAutocomplete(pi: ExtensionAPI): void {
	let skills: SkillInfo[] = [];
	const refreshSkills = () => {
		skills = getSkills(pi);
		return skills;
	};

	pi.registerCommand("skills-autocomplete-status", {
		description: "Show $skills autocomplete extension status",
		handler: async (_args, ctx) => {
			const currentSkills = refreshSkills();
			ctx.ui.notify(`$skills autocomplete loaded; ${currentSkills.length} skills available`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		refreshSkills();
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider(current => createSkillProvider(current, refreshSkills));
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
