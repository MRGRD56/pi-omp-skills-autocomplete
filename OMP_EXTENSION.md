# OMP `$skill` Autocomplete Extension

This document captures the OMP-specific implementation, behavior contract, development flow, and regression history for `omp-skills-autocomplete.ts`.

Plain `pi` behavior lives in `PI_EXTENSION.md` and `pi-skills-autocomplete.ts`. Do not merge OMP runtime imports or custom editor logic into the plain `pi` entrypoint.

## File and install path

Source file:

```text
omp-skills-autocomplete.ts
```

Local OMP install path:

```text
$HOME/.omp/agent/extensions/skills-autocomplete.ts
```

Windows local install path used on this workstation:

```text
C:/Users/SU/.omp/agent/extensions/skills-autocomplete.ts
```

Install from repository root:

```bash
mkdir -p "C:/Users/SU/.omp/agent/extensions" && cp ./omp-skills-autocomplete.ts "C:/Users/SU/.omp/agent/extensions/skills-autocomplete.ts"
```

## Import boundary

OMP imports from OMP packages only:

```ts
import type { AutocompleteItem, AutocompleteProvider, EditorTheme, KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { SelectList, getKeybindings } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { UserMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/user-message";
import { setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
```

Do not import plain `pi` packages in this file:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
```

OMP owns the custom editor and renderer implementation. These runtime imports must not leak into `pi-skills-autocomplete.ts`.

## Programmatic identifiers

Keep these identifiers stable:

```ts
const CUSTOM_TYPE = "skills-autocomplete-prompt";
const SKILL_PREFIX = "skill:";
```

Command name:

```text
skills-autocomplete-status
```

Status notification:

```text
$skills autocomplete loaded; N skills available
```

## Token rules

OMP token matching uses:

```ts
const TOKEN_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]*)$/;
const ALL_TOKENS_RE = /(^|[\s([{,;])\$([A-Za-z0-9_-]+)/g;
```

Supported skill-name characters:

```text
A-Z a-z 0-9 _ -
```

Rules:

- `$` alone is valid and shows all installed skills.
- `$token` filters installed skills.
- `$ ` returns no active skill token.
- `$$ ` returns no active skill token.
- Matching accepts start/whitespace/`(` / `[` / `{` / `,` / `;` before `$`.
- Do not broaden token parsing unless completion, rendering, hidden suffix, docs, and smoke tests are updated together.

## Skill discovery and validity

OMP treats installed skills as commands named `skill:<name>`:

```ts
pi.getCommands().filter(command => command.name.startsWith("skill:"))
```

The stored skill name strips the `skill:` prefix.

Validity rules:

- Only installed skills are treated as valid.
- Unknown `$tokens` stay as plain user text.
- Unknown `$tokens` must not be highlighted as known skills.
- Unknown `$tokens` must not appear in the hidden suffix.
- Duplicate valid mentions are deduplicated using first-seen order.

## Autocomplete provider and custom editor

OMP wraps the active autocomplete provider with `createSkillProvider(...)` and installs a custom editor through `ctx.ui.setEditorComponent(...)`.

Provider behavior:

- `getSuggestions` checks `line.slice(0, cursorCol)` and returns skill items when the active token matches.
- `buildSkillItems` returns values and labels with the leading `$`.
- `applyCompletion` replaces only the active `$token` prefix.
- Non-skill completions delegate to the current provider.
- `getInlineHint`, `trySyncSlashCompletion`, and `trySyncInlineReplace` are OMP provider concerns and must stay out of plain `pi` unless plain `pi` supports and verifies them.

Custom editor behavior:

- Typing `$` opens a skill popup.
- Typing `$token` filters skills.
- Deleting `$` or the active `$token` closes the popup immediately, including the empty prompt case.
- Up/Down navigation changes the selected popup row without editing text.
- Escape cancels the popup and suppresses immediate reopening for the same text.
- Tab or Enter completes the selected/current `$token` by replacing the full current `$token` with `$skill-name`.
- Completion must never insert a skill name without the leading `$`.
- Popup rows must remain one-line. Do not enable `wrapDescription: true`; long descriptions should be truncated by the TUI.

- Initialize the OMP module-local theme with `setThemeInstance(ctx.ui.theme)` before constructing the custom editor. The factory's `theme` parameter is only an `EditorTheme`; the base `CustomEditor` magic-keyword gradient needs the full OMP `Theme`.
Composer decoration may use ANSI styling because it happens before the user message renderer. Do not use ANSI styling inside `UserMessageComponent` Markdown rendering.

## Hidden model context injection

The submitted prompt must remain a normal OMP user message. Do not intercept `input` to replace it with a visible `skills-autocomplete-prompt` custom message.

When at least one valid `$skill` mention exists, inject a separate hidden custom message after the user prompt:

```text
($-Mentioned skills: docx, frontend-design)
```

Rules:

- Prefix must be `$-Mentioned skills:`.
- Use comma + space between skill names.
- Include only valid known skill names.
- Preserve first-seen order.
- Inject no hidden message when there are no valid skill mentions.
- Do not replace `$skill` with `skill` in the user prompt.
- Do not add verbose instructions around the hidden context.
- Use `display: false` so the context participates in the LLM turn without a visible transcript card.

Implementation shape:

```ts
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
```

## Message rendering

New hidden `skills-autocomplete-prompt` messages use `display: false` and normally do not render. Keep the custom renderer as a compatibility path for older displayed `skills-autocomplete-prompt` entries and for any future displayed diagnostic entry of the same type.

Renderer shape:

```ts
pi.registerMessageRenderer<RenderDetails>(CUSTOM_TYPE, (message, _options, theme) => {
	setThemeInstance(theme);
	const details = message.details ?? {};
	const displayText = details.displayText ?? message.content;
	return new UserMessageComponent(markdownHighlightSkillTokens(displayText, details.skills ?? []));
});
```

Rules:

- Use `UserMessageComponent` from `@oh-my-pi/pi-coding-agent`.
- Call `setThemeInstance(theme)` before constructing `UserMessageComponent`.
- Pass visually transformed `displayText` to `UserMessageComponent`; never render the hidden context as the user prompt.
- Do not render a custom `Container` / `Text("You")` frame.
- Do not instantiate `Markdown` directly unless a valid Markdown theme is passed.

Known-skill `$skill` highlighting in this renderer path is visual-only:

- Known skills may use Markdown inline-code styling by wrapping known tokens in backticks inside the renderer path.
- Renderer-generated backticks must never be inserted into `message.content` or the hidden context.
- If the user already wrote backticks around `$skill`, do not double-wrap that token.
- Avoid ANSI highlighting inside `UserMessageComponent` / Markdown. It can mangle `$skill` text.
- Unknown `$tokens` in the renderer path must be Markdown-escaped as `\$token`, not left raw. Raw unknown dollars can be parsed as Markdown/math delimiters and make later known `$skill` backticks visible or drop the visible `$`.
- Keep escaping visual-only: never insert renderer escape backslashes into `message.content` or the hidden context.

Current renderer helper behavior:

```ts
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
```

## Display formatting tradeoff

Older OMP behavior used a visible custom `skills-autocomplete-prompt` message for submitted prompts that mentioned skills. That custom message renderer could pass a visually transformed `displayText` into `UserMessageComponent`, so known `$skill` tokens were rendered with Markdown inline-code styling while the extension kept separate model-facing content in `message.content` / details.

Current behavior intentionally does not do that. The submitted prompt remains a normal OMP `role: "user"` message, and skill context is injected separately as a hidden `display: false` custom message from `before_agent_start`.

The tradeoff is deliberate:

- Normal OMP user messages are rendered directly by OMP's transcript builder through `new UserMessageComponent(textContent, ...)`.
- OMP extension `registerMessageRenderer(...)` applies only to custom messages, not to normal `role: "user"` messages.
- Therefore plugin-local visual-only `$skill` highlighting after submit is available for displayed custom messages, but not for true user messages.
- Adding Markdown backticks to the normal user message and stripping them later in a `context` hook would make the persisted/session-visible prompt differ from what the user typed and risks interfering with prompt expansion, mention extraction, exports, search, and other hooks.
- Keeping a normal user message is preferred because the transcript accurately represents user input, preserves OMP's native user-message semantics, and avoids a hidden two-way transform of displayed text versus LLM text.

Do not reintroduce an `input` handler solely to regain post-submit `$skill` highlighting unless the product decision explicitly prefers displayed custom messages over true user messages. A clean solution requires an OMP core/user-message-renderer extension point that can apply visual-only highlighting to normal user messages.


## Input handler contract

Do not use an `input` handler for skill hidden context in OMP. Let OMP submit the prompt normally, then inject hidden context from `before_agent_start`.

Reason: sending the prompt from an `input` handler requires a visible custom message and blocks the normal user message. If the handler shape is wrong, OMP also submits the original prompt and creates duplicates. `before_agent_start` avoids both problems.

If an unrelated future OMP input handler is added, the handled result shape is:

```ts
return { handled: true };
```

Do not use the older shape:

```ts
return { action: "handled" };
```

## Runtime lifecycle

Default export behavior:

1. Maintain a cached `skills` array refreshed from `getSkills(pi)`.
2. Call `pi.setLabel("$ Skills Autocomplete")` for the OMP extension label.
3. Register `/skills-autocomplete-status`.
4. Register the custom `skills-autocomplete-prompt` renderer for compatibility with displayed custom entries.
5. On `session_start`, refresh skills and install `SkillsAutocompleteEditor` when UI exists.
6. On `before_agent_start`, return a hidden `skills-autocomplete-prompt` message when valid skills are present.
7. On no valid mentions, return `undefined` and let OMP run with only the normal user prompt.

## Verification

From repository root:

```bash
bun --check ./omp-skills-autocomplete.ts
```

Installed copy check on this workstation:

```bash
bun --check "C:/Users/SU/.omp/agent/extensions/skills-autocomplete.ts"
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

After copying to the OMP extension directory, run:

```bash
bun --check "$HOME/.omp/agent/extensions/skills-autocomplete.ts"
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

For behavior changes, also run a loader smoke test that patches `runtime.getCommands` and verifies:

- no `input` handler is registered for skill hidden context;
- `before_agent_start` returns a hidden `skills-autocomplete-prompt` message when valid `$skill` mentions exist;
- `before_agent_start` returns `undefined` when no valid `$skill` mentions exist;
- hidden `message.content` is exactly `($-Mentioned skills: ...)` with valid skills deduplicated in first-seen order;
- hidden `message.display` is `false`;
- hidden `message.details.skills` contains only valid matched skill names;
- renderer compatibility path returns `UserMessageComponent` and does not throw.
- editor initialization calls `setThemeInstance(ctx.ui.theme)` before constructing `SkillsAutocompleteEditor`, so typing `orchestrate` renders without `theme.getColorMode` errors.

Focused renderer smoke tests should include a prompt like:

```text
$agent-browser $markdown-to-docx $not-a-real-skill $agent-browser $0.245
```

Expected renderer-path facts:

- both `$agent-browser` mentions are highlighted visually;
- `$markdown-to-docx` is highlighted visually;
- `$not-a-real-skill` and `$0` are escaped visually, not highlighted;
- hidden suffix is exactly `($-Mentioned skills: agent-browser, markdown-to-docx)`.

## Regression history and risks

1. Popup remained visible after deleting `$` from an otherwise empty prompt.
   - Cause: sync logic returned early for empty text before clearing popup state.
   - Guard: always compute token first and clear popup when no token.

2. Popup rows wrapped long skill descriptions and consumed all popup height.
   - Cause: `wrapDescription: true`.
   - Guard: omit `wrapDescription`; let `SelectList` truncate.

3. Tab completion inserted nothing or inserted a skill name without `$`.
   - Cause: stale prefix/suffix insertion logic.
   - Guard: replace the current `$token` using current text and `setText(...)`.

4. Unknown `$tokens` were highlighted.
   - Cause: regex-only highlighting without checking installed skill names.
   - Guard: build a known skill-name set and highlight only matches in that set.

5. LLM prompt stripped `$skill` from the user text.
   - Cause: transform replaced `$skill` with `skill`.
   - Guard: preserve original text and append only the compact hidden suffix.

6. Rendering `$docx`, `$frontend-design`, and repeated `$docx` crashed.
   - Cause: direct `new Markdown(...)` without required theme.
   - Guard: use `UserMessageComponent` and initialize theme with `setThemeInstance(theme)`.

7. Custom messages appeared as `skills-autocomplete-prompt` framed cards and duplicated as normal user messages.
   - Cause A: renderer threw, so OMP fell back to `CustomMessageComponent` frame.
   - Cause B: the old `input` handler sent a custom prompt message and could fail to block the normal submit if the handled result shape changed.
   - Guard: do not use `input` for hidden context; inject hidden `display: false` context from `before_agent_start` and let the normal user prompt submit.

8. ANSI-highlighted `$skill` text got mangled inside Markdown rendering.
   - Cause: ANSI escapes around `$...` before Markdown parsing.
   - Guard: use visual-only Markdown inline-code wrapping in renderer path; keep ANSI highlighting only in the composer decoration path if needed.

9. Repeated known `$skill` after an unknown `$token` rendered with visible backticks or without `$`.
   - Cause: raw unknown `$not-a-real-skill` / `$0` in `UserMessageComponent` Markdown could open a Markdown/math span before the next inline-code-highlighted known skill.
   - Guard: in `markdownHighlightSkillTokens`, wrap known skills in Markdown inline code and escape unknown `$tokens` as `\$token` in the renderer path only.

10. Typing `orchestrate` in the custom composer crashed with `theme.getColorMode` on an undefined theme.
    - Cause: the extension-loaded `@oh-my-pi/pi-coding-agent` module had its own uninitialized theme singleton; the crash stayed dormant until OMP's magic-keyword gradient rendered.
    - Guard: call `setThemeInstance(ctx.ui.theme)` in the editor factory before constructing `SkillsAutocompleteEditor`; do not pass the narrower `EditorTheme`. Smoke-test the installed extension by typing `orchestrate`.

11. OMP startup spent several seconds loading this extension and became much slower with cold filesystem caches.
    - Cause: the runtime import from the `@oh-my-pi/pi-coding-agent` package root resolves to `src/index.ts` in npm installations and loads the complete source module graph.
    - Guard: keep runtime imports on the narrow component/theme subpaths above; keep `ExtensionAPI` and `ExtensionContext` as type-only root imports.
