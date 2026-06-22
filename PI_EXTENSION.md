# Plain `pi` `$skill` Autocomplete Extension

This document captures the implementation and development rules for the plain `pi` entrypoint in this repository: `pi-skills-autocomplete.ts`.

OMP-specific behavior lives in `omp-skills-autocomplete.ts`. Do not merge the runtime imports or lifecycle hooks unless both targets are revalidated.

## File and install path

Source file:

```text
pi-skills-autocomplete.ts
```

Local install path:

```text
$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts
```

Windows local install path used on this workstation:

```text
C:/Users/SU/.pi/agent/extensions/pi-skills-autocomplete.ts
```

Install from repository root:

```bash
mkdir -p "C:/Users/SU/.pi/agent/extensions" && cp ./pi-skills-autocomplete.ts "C:/Users/SU/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

## Import boundary

The plain `pi` file uses type-only imports only:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
```

Do not import OMP packages in this file:

```text
@oh-my-pi/pi-coding-agent
@oh-my-pi/pi-tui
```

Do not import or use OMP custom UI pieces in plain `pi`:

```text
CustomEditor
SelectList
UserMessageComponent
setThemeInstance
EditorTheme
KeybindingsManager
TUI
```

## Public helpers

`pi-skills-autocomplete.ts` exports helper functions so behavior can be smoke-tested without loading the full runtime:

```ts
getSkills(pi)
findSkillToken(textBeforeCursor)
buildSkillItems(skills, query)
applyTextCompletion(lines, cursorLine, cursorCol, item, prefix)
findMentionedSkills(text, skills)
formatMentionedSkillsContext(matchedSkills)
createSkillProvider(current, getCurrentSkills)
```

Keep these helpers pure except for `getSkills`, which reads `pi.getCommands()`.

## Skill discovery

Plain `pi` exposes installed skills as slash commands with:

```ts
source: "skill"
name: "skill:<name>"
```

`getSkills` must filter by `command.source === "skill"`. Do not treat every command named `skill:*` as installed; an extension command can have that name and must not become a valid skill.

Returned skill names strip the optional `skill:` prefix and are sorted by name.

## Token rules

The current token regex is intentionally narrow:

```ts
/(^|[\s([{,;])\$([A-Za-z0-9_-]*)$/
```

Supported skill-name characters:

```text
A-Z a-z 0-9 _ -
```

Matching accepts `$token` at the start of the line or after whitespace / `(` / `[` / `{` / `,` / `;`.

Important edge cases:

- `$` alone is valid and shows all skills.
- `$ ` returns no skill token and delegates to the current provider.
- `$$ ` returns no skill token and delegates to the current provider.
- Unknown `$tokens` stay user text and are not included in hidden context.
- `$0.245` is parsed as `$0`; it is ignored unless a real installed skill named `0` exists.

Do not broaden token parsing unless autocomplete, mention extraction, docs, and smoke tests are updated together.

## Autocomplete provider

Plain `pi` uses native provider stacking:

```ts
ctx.ui.addAutocompleteProvider(current => createSkillProvider(current, refreshSkills));
```

The provider contract:

- `triggerCharacters` is exactly `["$"]`.
- `getSuggestions` inspects `line.slice(0, cursorCol)` so completion works at the current cursor position.
- If no `$token` matches, delegate to `current.getSuggestions(...)`.
- If the matched token produces no skill items, delegate to `current.getSuggestions(...)`.
- `applyCompletion` replaces only the active prefix before the cursor and preserves trailing text after the cursor.
- Non-skill completions delegate to `current.applyCompletion(...)`.
- `shouldTriggerFileCompletion` delegates to `current.shouldTriggerFileCompletion?.(...) ?? true`.

This is why `Use $doc here` with the cursor after `$doc` becomes `Use $docx here` rather than deleting ` here`.

Do not add OMP-only provider methods such as inline hints or sync slash completion unless plain `pi` exposes and verifies them.

## Runtime lifecycle

The default export registers three behaviors.

### Status command

Command name:

```text
skills-autocomplete-status
```

Expected notification:

```text
$skills autocomplete loaded; N skills available
```

### Session start

On `session_start`:

1. Refresh skills from `pi.getCommands()`.
2. If `ctx.hasUI` is false, do nothing else.
3. If UI exists, register the stacked autocomplete provider.

### Before agent start

On `before_agent_start`:

1. Refresh skills.
2. Extract valid mentions from `event.prompt` only.
3. Deduplicate valid mentions in first-seen order.
4. If no valid mentions exist, return `undefined`.
5. If valid mentions exist, return a hidden message:

```ts
{
	message: {
		customType: "skills-autocomplete-prompt",
		content: "($-Mentioned skills: docx, frontend-design)",
		display: false,
		details: { skills: ["docx", "frontend-design"] },
	},
}
```

The visible user prompt remains unchanged.

## Hidden context format

The format is exact:

```text
($-Mentioned skills: docx, frontend-design)
```

Rules:

- Prefix is `$-Mentioned skills:`.
- Separator is comma + space.
- Only installed skills are listed.
- First-seen order is preserved.
- Duplicate mentions are removed.
- Unknown `$tokens` are ignored.
- No suffix is added when no valid skill mention exists.

## Explicit non-goals

Plain `pi` must not:

- call `pi.setLabel("$ Skills Autocomplete")`;
- register a custom message renderer;
- register an `input` handler for hidden context;
- install a custom editor;
- import OMP runtime packages;
- mutate the visible user prompt to add the hidden context;
- claim automatic popup opening after punctuation before `$`.

The hidden context uses `before_agent_start` because plain `pi` input transforms affect stored user text.

## Verification

From repository root:

```bash
bun --check ./pi-skills-autocomplete.ts
pi -e ./pi-skills-autocomplete.ts
```

Installed copy check on this workstation:

```bash
bun --check "C:/Users/SU/.pi/agent/extensions/pi-skills-autocomplete.ts"
pi -e "C:/Users/SU/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

Behavior smoke tests should cover:

- `$` returns all skills.
- `$doc` ranks and returns `$docx` with the leading `$`.
- completion before trailing text preserves that trailing text;
- unknown `$tokens` do not create hidden context;
- repeated known mentions are deduplicated;
- command discovery filters by `source === "skill"`;
- provider delegates to the current provider when no skill token matches.

## Relationship to OMP implementation

The plain `pi` file intentionally duplicates small pure helpers from OMP instead of sharing runtime modules. Shared code may be extracted later only if:

- both entrypoints keep runtime imports isolated;
- OMP custom editor and renderer remain OMP-only;
- plain `pi` native provider stacking remains plain-`pi`-only;
- both entrypoints pass their own loader and smoke checks.
