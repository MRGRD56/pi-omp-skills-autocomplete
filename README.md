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

- Stacks a skill provider through `ctx.ui.addAutocompleteProvider` without replacing the native composer or its built-in providers (including `^` model completion).
- `$` opens OMP's native autocomplete menu in supported trigger positions, including after whitespace or `(`, `[`, `{`, `,`, or `;`. The extension doesn't render a second menu.
- Tab or Enter accepts the skill, replacing the whole `$token` even with the caret inside it. Trailing text is preserved; after acceptance, Enter submits normally.
- Escape dismisses the menu without changing the prompt. Deleting the active token closes the skill menu.
- Known mentions are highlighted in the draft. Submitted prompts remain normal user messages; the compatibility renderer only applies to older displayed `skills-autocomplete-prompt` entries.
- Targets OMP 19.2.0's standard interactive terminal composer. Vim modes and Tern have not been verified.

### plain `pi`

- Uses native stacked autocomplete providers via `ctx.ui.addAutocompleteProvider(...)`.
- Completes the current `$token` at the cursor, including before trailing text.
- Does not install a custom editor or custom renderer.
- Does not claim automatic popup opening after punctuation before `$`; upstream immediate provider opening is start/space/tab based.

## Requirements

- OMP install: OMP 19.2.0 available as `omp` for extension v0.3.0. For the previous OMP integration, use the rollback below with your older host.
- plain `pi` install: plain `pi` available as `pi`.
- Bun runtime available to extension loading.
- Existing skills exposed as `skill:<name>` commands.

## Install: OMP

Install the OMP extension directly from GitHub:

```bash
omp plugin install github:MRGRD56/pi-omp-skills-autocomplete
```

Force-update an existing GitHub installation from the default branch:

```bash
omp plugin install github:MRGRD56/pi-omp-skills-autocomplete --force
```

To return to extension v0.2.0 for OMP 18.5.0:

```bash
omp plugin install "github:MRGRD56/pi-omp-skills-autocomplete#v0.2.0" --force
```

OMP's GitHub shorthand uses `#tag`, not `@tag`. Rolling back the extension does not change your OMP version.

Restart OMP after installing, updating, rolling back, or linking; the extension loads at startup.

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

OMP (restart after installing):

```bash
omp --version
omp plugin list --json
omp
```

Run `/skills-autocomplete-status` inside the interactive OMP session. The notification reports the available skill count.

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
omp
pi -e .
```

In OMP, run `/skills-autocomplete-status` and follow the [native composer smoke checks](OMP_EXTENSION.md#verification).

## Notes

- The extensions intentionally avoid changing core OMP/TUI or plain `pi` code.
- OMP and plain `pi` remain separate entrypoints selected by the `omp` and `pi` manifests in `package.json`.
- OMP imports from `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`.
- plain `pi` imports types from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- Both targets inject skill context as hidden context while preserving the visible prompt as normal user text.
