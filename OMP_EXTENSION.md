# OMP `$skill` Autocomplete Extension

Extension v0.3.0 targets OMP 19.2.0's standard interactive terminal composer. The OMP development packages are pinned to 19.2.0. Vim modes and Tern have not been verified.

Plain `pi` behavior lives in `PI_EXTENSION.md` and `pi-skills-autocomplete.ts`. Keep OMP runtime imports and composer integration out of the plain `pi` entrypoint.

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

Force-update a GitHub installation from the default branch, or force-install the rollback tag for OMP 18.5.0:

```bash
omp plugin install github:MRGRD56/pi-omp-skills-autocomplete --force
omp plugin install "github:MRGRD56/pi-omp-skills-autocomplete#v0.2.0" --force
```

Use `#tag` in OMP's GitHub shorthand: `@v0.2.0` is not a GitHub ref separator in OMP 19.2.0. This rollback changes the extension, not the OMP executable.

Link the repository checkout while developing:

```bash
omp plugin link .
```

Restart OMP after installing, updating, rolling back, or linking. OMP loads the package-managed entrypoint at startup.

Do not copy this file to `$HOME/.omp/agent/extensions`. A copied file bypasses package management and can load alongside the packaged entrypoint.

## Import boundary

Keep OMP imports in `omp-skills-autocomplete.ts`. Prefer type-only imports for host contracts; use OMP's host-provided runtime for composer access and the `@oh-my-pi/pi-tui` JSX Markdown renderer. Do not load a second coding-agent source graph or initialize a theme singleton. The `@earendil-works/` packages belong to the plain `pi` target only.

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

## Native autocomplete and composer integration

`ctx.ui.addAutocompleteProvider(...)` wraps the active host provider; neither the provider chain nor the composer is replaced. The host owns the popup, its layout, navigation, and ordinary acceptance. The extension uses native composer key/edit APIs to open that same popup for `$` and complete a candidate in one edit when acceptance arrives before the popup has refreshed. The draft uses native accent/strong decoration for known tokens.

- Skill results are fuzzy-ranked (exact match, prefix, substring, then ordered subsequence), tie-broken by name, and limited to 30. Item values retain the leading `$`.
- Completion replaces the entire skill-token span, leaves surrounding text and draft atoms intact in one undoable edit, and puts the caret after the inserted value. If a stale accept no longer resolves to a skill token, it must not rewrite unrelated text.
- Inline ghost text is only applicable at the end of the token. An acceptance or dismissal shouldn't reopen the popup on repaint; editing or moving away from that context permits a new trigger.
- Preserve delegation to the wrapped provider, including cancellation/partial results and optional host hooks. Check ordinary slash, file/`@`, and `^` model completion after changes to the wrapper.

### OMP 19.2.0 compatibility seam

Public provider registration is sufficient to supply suggestions, but the public extension UI does not expose the live composer/caret or a way to register `$` as an automatic popup trigger. During synchronous `ctx.ui.addAutocompleteProvider(...)` registration, the integration briefly wraps the host's `InteractiveMode.prototype.addAutocompleteProvider` to capture that mode's live composer, then immediately restores the method. This depends on OMP 19.2.0's interactive implementation, not a stable extension API. Recheck the registration call chain and composer edit/key contracts on every host upgrade; keep the wrapper scoped to registration rather than intercepting future registrations globally.

## Hidden model context injection

The submitted prompt must remain a normal OMP user message. On `before_agent_start`, refresh the skill cache, extract mentions from `event.prompt`, and return the separate hidden message only when at least one known skill is present. Do not intercept `input` to replace the prompt with a visible `skills-autocomplete-prompt` custom message.

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

## Rendering older displayed entries

New `skills-autocomplete-prompt` entries are hidden and normally do not render. The renderer for older **displayed** entries uses the OMP TUI JSX Markdown renderer (`md`), with `details.displayText` preferred over the text from `message.content`. When content is multipart, text parts are joined with newlines; images aren't rendered by this compatibility path.

Known tokens use visual-only Markdown inline-code styling without double-wrapping tokens already in backticks. Escape unknown dollar tokens in the renderer only, so they do not open math spans and corrupt subsequent known mentions. Do not add ANSI escapes, backticks, or escape backslashes to stored or model-facing content. The renderer cannot decorate normal user messages after submission; do not intercept `input` or send a visible custom substitute to regain that effect.

## Verification

From the repository root:

```bash
bun install
bun test
bun run check
omp --version
```

For a linked-package smoke test (use only one loading route):

```bash
omp plugin link .
omp plugin list --json
omp
```

Check that OMP is 19.2.0 and lists one enabled `pi-omp-skills-autocomplete` package. Its OMP manifest must list only `./omp-skills-autocomplete.ts`; remove any duplicate loose legacy entrypoint before testing. For a GitHub release, repeat the smoke against the installed GitHub source after restarting OMP.

In the standard interactive composer with installed skills:

1. Run `/skills-autocomplete-status`; check that the reported count matches the installed skills. Print mode does not check this UI path.
2. Type `$` at the start and after whitespace or a supported punctuation boundary. Check for a single native menu. Filter with a partial skill name, navigate, then accept with Tab and Enter in separate trials. Try Enter immediately after typing, before the menu refreshes: the first Enter should complete, not submit.
3. Accept with the caret inside a token and trailing text after it. Confirm the whole token is replaced, `$` is retained, and one undo restores the draft. Include surrounding placeholders or atoms where available.
4. Test Escape and deletion of the whole token, including an otherwise empty draft. The popup should close without submitting or reopening on repaint; editing into a new token can reopen it. Check that no second menu appears during slow refreshes or transitions from another provider.
5. Check `/`, file/`@`, and `^` model completion still work. Try a narrow terminal and a long skill description; inspect native menu layout and navigation.
6. Check that only installed mentions are decorated in the draft. Submit a prompt with repeated known and unknown mentions: the user message stays unchanged and the hidden context contains each known skill once, in first-seen order. Separately check an older displayed entry with a known token, an unknown token, then the known token again; the second known token should still render as inline code.

## Regression history

- **OMP 18.x custom editor only:** The extension-owned list could double-render with a debounced native list, wrap long descriptions, stay visible after deletion, reopen after native acceptance, or lose Escape/early Enter while a stale native list was active. The 19.2.0 port removes the second list and editor replacement. Keep the dismissal, empty-draft, and early-acceptance checks: native popup state and refresh timing still matter.
- **Old host imports and theme state:** Loading coding-agent runtime modules from disk caused slow cold starts and a second theme singleton; decorator signature changes also broke rendering. The native composer and host runtime replace that setup. `SelectList` is no longer exported by OMP 19.2.0.
- **Completion integrity:** Prefix-only replacement duplicated the token tail with an interior caret; stale acceptance could corrupt unrelated text. Preserve whole-token, one-edit replacement and the stale-span guard.
- **Transcript integrity:** An old `input` path duplicated prompts or stripped leading dollars. Keep the normal user message plus hidden context. For legacy displayed entries, visual ANSI styling and raw unknown dollars previously broke Markdown; keep styling/escaping in the Markdown renderer only.
- **Skill validity:** A command named `skill:*` is not sufficient without `source: "skill"`. The same discovery filter must govern completion, draft decoration, and hidden context.
