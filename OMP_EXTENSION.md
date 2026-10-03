# OMP `$skill` Autocomplete Extension

This document captures the OMP-specific implementation, behavior contract, development flow, and regression history for `omp-skills-autocomplete.ts`.

Plain `pi` behavior lives in `PI_EXTENSION.md` and `pi-skills-autocomplete.ts`. Do not merge OMP runtime imports or custom editor logic into the plain `pi` entrypoint.

## Package manifest and installation

Source file:

```text
omp-skills-autocomplete.ts
```

The repository-root `package.json` exposes only this file to OMP:

```json
{
  "omp": {
    "extensions": ["./omp-skills-autocomplete.ts"]
  }
}
```

Install from GitHub:

```bash
omp plugin install github:MRGRD56/pi-omp-skills-autocomplete
```

Link the repository checkout while developing:

```bash
omp plugin link .
```

Restart the active OMP session after installing or linking; the extension is loaded at startup and is exposed to OMP only through the package manifest.

Do not copy this file to `$HOME/.omp/agent/extensions`. A copied file bypasses package management and can load alongside the packaged entrypoint.

## Import boundary

OMP imports from OMP packages only:

```ts
import type { AutocompleteItem, AutocompleteProvider, EditorTheme, KeybindingsManager, TUI } from "@oh-my-pi/pi-tui";
import { SelectList } from "@oh-my-pi/pi-tui";
import type { CustomEditor, CustomMessageContent, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
```

Do not import plain `pi` packages in this file:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
```

OMP owns the custom editor and renderer implementation. Runtime coding-agent values come from the injected `pi.pi` host namespace so the extension does not load OMP's internal source modules from disk. These dependencies must not leak into `pi-skills-autocomplete.ts`.

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
const TOKEN_CHAR_RE = /[A-Za-z0-9_-]/;
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
- `findSkillSpan(line, cursorCol)` resolves the whole `$token` around the caret: the left half via `TOKEN_RE`, the right half by scanning forward with `TOKEN_CHAR_RE`, so a caret placed inside `$skill` still addresses the complete token. Its `prefix` is only the text before the caret and is what the wrapped host matches on.
- Do not broaden token parsing unless completion, rendering, hidden suffix, docs, and smoke tests are updated together.

## Skill discovery and validity

OMP recognizes an installed skill only when the host tags the command with both pieces of native metadata: `source === "skill"` and a `skill:<name>` command name.

```ts
pi
	.getCommands()
	.filter(command => command.source === "skill" && command.name.startsWith(SKILL_PREFIX))
```

The stored skill name strips the `skill:` prefix. A command that is merely named `skill:<name>` but is not tagged `source: "skill"` must not become a valid skill.

Discovery is cached into a `{ skills, names }` pair (`buildSkillCache`): the sorted `skills` array feeds the popup, and `names` is a `Set` for O(1) highlighting and validity checks. The cache refreshes on `session_start`, whenever the host rebuilds the stacked provider (the `addAutocompleteProvider` factory), from the `/skills-autocomplete-status` handler, and on `before_agent_start`. Rendering and keystroke paths read the cached array/`Set` and never call `getCommands()` or sort per key.

Validity rules:

- Only installed skills (matching `source` and name prefix) are treated as valid.
- Unknown `$tokens` stay as plain user text.
- Unknown `$tokens` must not be highlighted as known skills.
- Unknown `$tokens` must not appear in the hidden suffix.
- Duplicate valid mentions are deduplicated using first-seen order.

## Autocomplete provider and custom editor

OMP wraps the active autocomplete provider with `createSkillProvider(...)` and stacks it with `ctx.ui.addAutocompleteProvider(...)`; it does not replace the built-in provider through `ctx.ui.setAutocompleteProvider`. A custom composer editor is installed separately through `ctx.ui.setEditorComponent(...)`.

Provider behavior (`createSkillProvider`):

- `getSuggestions` resolves the whole `$token` under the caret with `findSkillSpan` and returns `{ items, prefix: span.prefix }` when the token yields items. It returns `null` when `signal?.aborted`, and otherwise delegates to `current.getSuggestions(...)`, forwarding the same `signal` and `onPartial` the host passed in.
- `buildSkillItems` scores installed skills for the query, caps the list at 30, and returns values/labels with the leading `$` plus the skill description.
- `applyCompletion` for a `$` completion replaces the complete token span (`span.start`→`span.end`) with the item value, preserves the text after the token, puts the caret after the inserted value, and returns `onApplied: onSkillApplied`. A stale accept whose span no longer resolves returns the buffer unchanged (no-op) instead of rewriting unrelated characters. Non-skill completions delegate to `current.applyCompletion(...)`.
- `getInlineHint` returns ghost text only at the token tail (`span.end === cursorCol`) and only when the top item extends the prefix; a caret inside the token returns `null` so the characters after the caret are not duplicated.
- Optional host hooks are forwarded only when the base provider exposes them, so stacking never invents capabilities core did not have: `trySyncSlashCompletion` and `trySyncInlineReplace` are bound through, `getForceFileSuggestions` stays skill-aware for `$` spans and aborted-checked before delegating, and `shouldTriggerFileCompletion` forces native completion on when a `$` span exists.

Custom editor behavior (`SkillsAutocompleteEditor`):

- Typing `$` opens a skill popup; typing `$token` filters skills.
- Exactly one skill popup is visible at a time. While native autocomplete is active (`isAutocompleteActive()`), native owns the screen and the extension's own `SelectList` stays prepared but hidden; it renders only once native is not active. This covers the window where core still holds a stale list while waiting for its debounced refresh.
- While native is active, Escape is routed through the public `handleDraftEdit(data)` instead of `handleInput`, so core's app-level Escape handler cannot leave the native state (and its pending refresh) alive.
- If the host cancels a stale native menu without applying anything and the buffer revision is unchanged, the extension honours the key by completing its prepared candidate instead: the first Enter completes the token, the next Enter submits.
- When the wrapped provider applies a skill (`onApplied`), the editor pins the completed context as dismissed, so acceptance through Tab, Enter, Right Arrow, an unchanged token, or a pointer click cannot reopen the extension popup.
- A temporary public `disableSubmit` guard prevents a stale native Enter from submitting the `$` draft.
- Deleting `$` or the active `$token` closes the popup immediately, including the empty prompt case.
- Up/Down/PageUp/PageDown navigate the extension popup without editing text.
- Extension completion applies the prepared item as one host edit over the whole token span through `applyHostEdit({ from, to, text, cursor, len })`: a single undo, preserved placeholders/atoms and trailing text, and the caret after the inserted value. Even when the token already equals the accepted value, the context is pinned as dismissed.
- Dismissal identity is `textRevision` + line + column + `span.start` + `span.end`; any edit, undo, or caret move expires the pin, so a dismissed token stays closed until the cursor or text leaves it.
- Completion must never insert a skill name without the leading `$`.
- Popup rows must remain one-line. Do not enable `wrapDescription: true`; long descriptions should be truncated by the TUI.
- Composer decoration (`highlightSkillTokens`) wraps known tokens with the live theme (`theme.bold(theme.fg("accent", ...))`) read through a `() => ctx.ui.theme` getter; the base decorator's decoration context is forwarded unchanged.
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
	const currentSkills = refreshCache().skills;
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
	pi.pi.setThemeInstance(theme);
	const details = message.details ?? {};
	const displayText = details.displayText ?? customMessageText(message.content);
	return new pi.pi.UserMessageComponent(markdownHighlightSkillTokens(displayText, details.skills ?? []));
});
```

`customMessageText` flattens a custom message's `content` (a `string` or a `TextContent`/`ImageContent[]` array) into display text: string content is returned as-is, otherwise the text parts are joined with newlines. Image parts contribute nothing; this renderer makes no image-rendering claim.

Rules:

- Use `UserMessageComponent` from the injected `pi.pi` host namespace.
- Call `pi.pi.setThemeInstance(theme)` before constructing `UserMessageComponent`.
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

1. Maintain one `SkillCache` (`{ skills, names }`) built by `buildSkillCache(pi)` and refreshed by `refreshCache()`.
2. Call `pi.setLabel("$ Skills Autocomplete")` for the OMP extension label.
3. Register `/skills-autocomplete-status`, which refreshes the cache and reports the filtered skill count.
4. Register the custom `skills-autocomplete-prompt` renderer for compatibility with displayed custom entries.
5. On `session_start`, refresh the cache and, when UI exists, install `SkillsAutocompleteEditor` once through `setEditorComponent(...)`, then stack the skill provider through `addAutocompleteProvider(...)` (installed after the editor so the host rebuilds the wrapped provider onto it). Repeats refresh the cache without reinstalling the editor.
6. On `before_agent_start`, refresh the cache and return a hidden `skills-autocomplete-prompt` message when valid skills are present.
7. On no valid mentions, return `undefined` and let OMP run with only the normal user prompt.

## Verification

From repository root:

```bash
bun install
bun test
bun run check
omp plugin link .
omp plugin list --json
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

`bun test` runs the focused behavioral suite in `tests/omp-skills-autocomplete.test.ts` (25 tests) against the real default export and the host editor factory. The suite covers `$` token boundaries and popup open/close, Tab/Enter/caret-inside-token completion, multiline completion, Escape and dismissal expiry, one-undo completion with preserved atoms and tail, composer highlighting, hidden-context dedup and source-metadata filtering, and native-menu arbitration (debounced refresh, cancel, acceptance, pointer activation, superseded slow lookup, forced file Tab).

`omp plugin list --json` must show one enabled `pi-omp-skills-autocomplete` package whose manifest contains only `./omp-skills-autocomplete.ts`. The legacy `$HOME/.omp/agent/extensions/skills-autocomplete.ts` file must not exist.

Manual smoke against a linked package in an interactive OMP session (restart OMP after installing or linking):

- `/skills-autocomplete-status` reports the filtered skill count;
- type `$` at a token boundary and see exactly one skill popup;
- type `$front`, then Tab or Enter, and get `$frontend-design` with the popup closed; a second Enter submits the prompt;
- place the caret inside a token, accept, and confirm the whole token is replaced with trailing text and placeholders preserved;
- press Escape and confirm the popup closes without changing the prompt;
- with a native file or `@` list still pending, confirm only one menu is ever visible.

The renderer compatibility path still deserves a focused check. Include a prompt like:

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
   - Guard: replace the whole current `$token` span through `applyHostEdit(...)` so completion is one undoable host edit; the leading `$` comes from the item value.

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
    - Cause: runtime imports from the coding-agent package root or internal component/theme subpaths make a compiled OMP process read and transpile the installed source module graph. After `omp update` or a reboot, cold filesystem and antivirus caches amplify that work.
    - Guard: keep `CustomEditor`, `ExtensionAPI`, and `ExtensionContext` as type-only imports; obtain `CustomEditor`, `UserMessageComponent`, and `setThemeInstance` from the injected `pi.pi` host namespace. Keep only the bundled `@oh-my-pi/pi-tui` root as a runtime package import.

12. Typing the first character in OMP 18.0.0 crashed in `renderText` while reading `context.line`.
    - Cause: OMP 18 added an `EditorTextDecorationContext` second argument to `decorateText(text, context)`. The extension wrapper forwarded only `text`, so the base `CustomEditor` received `undefined` context.
    - Guard: the composer decoration wrapper must forward the optional decoration context unchanged to the base decorator. Keeping the parameter optional in the extension compatibility type is ABI tolerance only; OMP 17.x is no longer a supported whole-extension target because the current extension also relies on provider/editor APIs introduced in OMP 18, and it is tested against OMP 18.5.0.

13. Two skill popups could be visible around the native provider's debounced refresh.
    - Cause: the extension rendered its own `SelectList` even while native autocomplete was active; the native list can be stale or narrowed to no candidate while core waits for its debounce.
    - Guard: render the extension popup only when `!isAutocompleteActive()`. The own list stays prepared but hidden while native owns the screen, so exactly one menu is visible. Test: "never renders two skill menus around the debounced native refresh".

14. Enter before the native refresh submitted the `$` draft instead of completing it.
    - Cause: native had no candidate yet, and the submit key reached the base editor.
    - Guard: while native is active with a prepared extension candidate, a temporary public `disableSubmit` blocks the submit; when native cancels without applying, the prepared candidate is completed instead, so the first Enter completes and the next Enter submits. Test: "Enter before the debounced refresh completes the skill instead of submitting".
    - Limit: in exotic slash-argument scopes an extra Enter before submit remains possible; treat that as a conservative posture, not a verified guarantee.

15. Native acceptance reopened the extension popup.
    - Cause: completion was only observed through the editor's own `handleInput`, so Right Arrow, pointer activation, a Tab accept against a stale native list, or accepting an already-complete token left the context un-dismissed.
    - Guard: the wrapped provider returns `onApplied: onSkillApplied`, and `#noteNativeSkillApplied` pins the completed context as dismissed. Tests: native accept, right-arrow accept, pointer activation, already-complete token.

16. Completion with the caret inside a token left duplicate characters.
    - Cause: only the text before the caret was treated as the active token.
    - Guard: `findSkillSpan` covers both halves of the token, and completion replaces the whole span through one host edit; inline ghost text is emitted only at the token tail. Tests: caret-inside-token completion, multiline completion, one-undo edit with preserved atoms and tail.

17. Escape with an active-but-hidden native list was swallowed by core.
    - Cause: `CustomEditor` turns Escape on a hidden native list into the app interrupt, leaving the pending native refresh alive.
    - Guard: while native is active, cancellation is routed through the public `handleDraftEdit(data)` so Escape clears the native state; afterwards only a changed token context may reopen the extension popup. Test: "Escape with a hidden native list leaves normal prompt mode".
    - Limit: pre-existing core Vim interception can still consume Escape in some modes (for example Insert→Normal on an active-but-invisible native list). Only the default composer path is verified; no claim is made that every Vim mode is fixed.

18. A stale pointer accept could rewrite unrelated characters.
    - Cause: an accept that arrived after the buffer moved on (for example a pointer click) rewrote characters that no longer formed the token.
    - Guard: `applyCompletion` returns the buffer unchanged when the token span no longer resolves, so a stale native accept accepts nothing; the extension popup may then surface as cancelled behaviour.

19. Dismissal state could pin forever or fail to survive a repaint.
    - Cause: a plain dismissed flag had no context identity.
    - Guard: dismissal identity is `textRevision` + line + column + `span.start` + `span.end`; any edit, undo, or caret move expires the pin. Tests: "Escape closes the popup without reopening on a repaint", "a dismissed popup reopens once the token context changes", "accepting an already-complete token keeps the popup dismissed".

20. Name-only `skill:*` commands were treated as installed skills.
    - Cause: discovery matched the `skill:` name prefix without checking the host's command source metadata.
    - Guard: discovery requires `command.source === "skill"` together with the `skill:` prefix, so a decoy command with the skill-name shape but another source never highlights, completes, or reaches the hidden suffix. Test: the decoy source-filter hidden-context and highlighting check.
