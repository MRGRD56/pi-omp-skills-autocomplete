# `$skill` Autocomplete Extensions for OMP and plain `pi`

<img width="686" height="83" alt="image" src="https://github.com/user-attachments/assets/bcfe0e75-20af-45ce-9a7a-40bd6b30a132" />

<img width="427" height="166" alt="image" src="https://github.com/user-attachments/assets/daa8c98b-e238-4fc8-980a-09ee0377daf0" />


This repository contains separate `$skill` autocomplete extension entrypoints for **Oh My Pi / OMP** and plain **`pi`**.

- `omp-skills-autocomplete.ts` targets OMP and is the package-managed entrypoint exposed by the `omp` manifest in `package.json` (`omp.extensions`).
- `pi-skills-autocomplete.ts` targets plain `pi` and is the package-managed entrypoint exposed by the `pi` manifest in `package.json` (`pi.extensions`).

Install either one through its package manager. Do not copy an entrypoint into `~/.omp/agent/extensions` or `~/.pi/agent/extensions`: a copied file bypasses package management and can load alongside the packaged entrypoint.

Both versions discover installed skills from `skill:<name>` commands, complete `$skill-name` with a leading `$`, and add valid skill mentions to the model context without replacing the original user text.

## Features

- `$` opens a skill popup in supported composer trigger positions.
- `$doc` filters skills by fuzzy match.
- Tab or Enter completes the currently selected `$skill-name`.
- Only known skills are highlighted or included in model-visible context.
- Unknown `$tokens` remain plain user text.
- Sent user text keeps the original `$skill-name` mentions.
- When valid skill mentions exist, the extension appends compact hidden context for the model:

  ```text
  ($-Mentioned skills: docx, frontend-design)
  ```

- Repeated mentions are deduplicated while preserving first-seen order.

## Target behavior differences

### OMP

- Stacks a native autocomplete provider (`ctx.ui.addAutocompleteProvider`) with a custom composer editor (`ctx.ui.setEditorComponent`); the built-in provider is wrapped, not replaced.
- Shows exactly one skill popup at a time: the native menu owns the screen while it is active, and the extension's own composer popup appears only once it is not.
- Completes the whole `$token` under the caret, so Tab or Enter works with the caret inside the token and preserves the text after it.
- Keeps a custom renderer compatibility path for older displayed `skills-autocomplete-prompt` entries.
- Deleting `$` or `$token` closes the popup immediately, including an empty prompt.
- Escape cancels the popup (and any pending native menu) without changing the prompt.
- Popup rows are one-line; long descriptions are truncated by the TUI instead of wrapping.
- Valid skill context is injected as a hidden `skills-autocomplete-prompt` message after the normal user prompt.
- Post-submit `$skill` highlighting is intentionally not applied to normal OMP user messages; OMP exposes custom renderers only for custom messages, and this extension prefers preserving a true user message over a displayed custom-message substitute.
- Tested against OMP 18.5.0.
- Some core OMP Vim modes can still consume Escape while a native list is active; the default composer path is the verified one.

### plain `pi`

- Uses native stacked autocomplete providers via `ctx.ui.addAutocompleteProvider(...)`.
- Completes the current `$token` at the cursor, including before trailing text.
- Does not install a custom editor or custom renderer.
- Does not claim automatic popup opening after punctuation before `$`; upstream immediate provider opening is start/space/tab based.

## Requirements

- OMP install: OMP available as `omp` (tested against OMP 18.5.0).
- plain `pi` install: plain `pi` available as `pi`.
- Bun runtime available to extension loading.
- Existing skills exposed as `skill:<name>` commands.

## Install: OMP

Install the OMP extension directly from GitHub:

```bash
omp plugin install github:MRGRD56/pi-omp-skills-autocomplete
```

Restart the active OMP session after installing or linking; the extension is loaded at startup.

## Install: plain `pi`

Install the plain `pi` extension from the same GitHub repository:

```bash
pi install git:github.com/MRGRD56/pi-omp-skills-autocomplete
```

The equivalent full-URL form is:

```bash
pi install https://github.com/MRGRD56/pi-omp-skills-autocomplete
```

## Verify installation

OMP:

```bash
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

plain `pi`:

```bash
pi list
```

Both package managers read `package.json` and load only their target-specific entrypoint. In interactive mode, `/skills-autocomplete-status` reports how many skills are available.

## Usage

1. Start OMP or plain `pi` interactive mode.
2. Type `$` at the start of the prompt or after a space.
3. Type part of a skill name to filter suggestions.
4. Press Tab or Enter to complete the selected skill.
5. Send your message normally.

Example prompt:

```text
Use $docx and $frontend-design to review this file.
```

The visible prompt keeps that text. The model also receives:

```text
($-Mentioned skills: docx, frontend-design)
```

Unknown mentions are ignored for the hidden context:

```text
Use $docx and $not-a-skill
```

Only `docx` is included if `not-a-skill` is not installed.

## Development workflow

The source of truth during development is this repository:

```text
omp-skills-autocomplete.ts
pi-skills-autocomplete.ts
```

Link the repository as an OMP plugin while developing:

```bash
omp plugin link .
```

Load the same checkout temporarily as a plain `pi` package:

```bash
pi -e .
```

Install dependencies once, then run the focused behavior tests and the compile check:

```bash
bun install
bun test
bun run check
```

Then verify both entrypoints and package manifests:

```bash
omp plugin list --json
pi -e .
```

## Notes

- The extensions intentionally avoid changing core OMP/TUI or plain `pi` code.
- OMP and plain `pi` remain separate entrypoints selected by the `omp` and `pi` manifests in `package.json`.
- OMP imports from `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`.
- plain `pi` imports types from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- Both targets inject skill context as hidden context while preserving the visible prompt as normal user text.
