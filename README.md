# `$skill` Autocomplete Extensions for OMP and plain `pi`

This repository contains separate `$skill` autocomplete extension entrypoints for **Oh My Pi / OMP** and plain **`pi`**.

- `omp-skills-autocomplete.ts` targets OMP and installs as `~/.omp/agent/extensions/skills-autocomplete.ts`.
- `pi-skills-autocomplete.ts` targets plain `pi` and installs as `~/.pi/agent/extensions/pi-skills-autocomplete.ts`.

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

- Installs a custom editor for the OMP composer.
- Keeps a custom renderer compatibility path for older displayed `skills-autocomplete-prompt` entries.
- Deleting `$` or `$token` closes the popup immediately, including an empty prompt.
- Escape cancels the popup without changing the prompt.
- Popup rows are one-line; long descriptions are truncated by the TUI instead of wrapping.
- Valid skill context is injected as a hidden `skills-autocomplete-prompt` message after the normal user prompt.
- Post-submit `$skill` highlighting is intentionally not applied to normal OMP user messages; OMP exposes custom renderers only for custom messages, and this extension prefers preserving a true user message over a displayed custom-message substitute.

### plain `pi`

- Uses native stacked autocomplete providers via `ctx.ui.addAutocompleteProvider(...)`.
- Completes the current `$token` at the cursor, including before trailing text.
- Does not install a custom editor or custom renderer.
- Does not claim automatic popup opening after punctuation before `$`; upstream immediate provider opening is start/space/tab based.

## Requirements

- OMP install: OMP available as `omp`.
- plain `pi` install: plain `pi` available as `pi`.
- Bun runtime available to extension loading.
- Existing skills exposed as `skill:<name>` commands.

## Install: OMP

Create the OMP extension directory and download the OMP extension file into it:

```bash
mkdir -p "$HOME/.omp/agent/extensions" && curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/pi-omp-skills-autocomplete/main/omp-skills-autocomplete.ts -o "$HOME/.omp/agent/extensions/skills-autocomplete.ts"
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\extensions" | Out-Null; Invoke-WebRequest -Uri "https://raw.githubusercontent.com/YOUR_GITHUB_USER/pi-omp-skills-autocomplete/main/omp-skills-autocomplete.ts" -OutFile "$env:USERPROFILE\.omp\agent\extensions\skills-autocomplete.ts"
```

## Install: plain `pi`

Create the plain `pi` extension directory and download the plain `pi` extension file into it:

```bash
mkdir -p "$HOME/.pi/agent/extensions" && curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USER/pi-omp-skills-autocomplete/main/pi-skills-autocomplete.ts -o "$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.pi\agent\extensions" | Out-Null; Invoke-WebRequest -Uri "https://raw.githubusercontent.com/YOUR_GITHUB_USER/pi-omp-skills-autocomplete/main/pi-skills-autocomplete.ts" -OutFile "$env:USERPROFILE\.pi\agent\extensions\pi-skills-autocomplete.ts"
```

Replace `YOUR_GITHUB_USER` with the actual GitHub owner after publishing this repository.

## Verify installation

OMP:

```bash
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

plain `pi` development quick test:

```bash
pi -e ./pi-skills-autocomplete.ts
```

A successful load exits without an extension import error. In interactive mode, `/skills-autocomplete-status` reports how many skills are available.

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

After editing the OMP entrypoint, copy it to the active OMP extension directory:

```bash
cp omp-skills-autocomplete.ts "$HOME/.omp/agent/extensions/skills-autocomplete.ts"
```

On Windows PowerShell:

```powershell
Copy-Item .\omp-skills-autocomplete.ts "$env:USERPROFILE\.omp\agent\extensions\skills-autocomplete.ts" -Force
```

After editing the plain `pi` entrypoint, copy it to the active plain `pi` extension directory:

```bash
cp pi-skills-autocomplete.ts "$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

On Windows PowerShell:

```powershell
Copy-Item .\pi-skills-autocomplete.ts "$env:USERPROFILE\.pi\agent\extensions\pi-skills-autocomplete.ts" -Force
```

Then verify the changed entrypoint:

```bash
bun --check ./omp-skills-autocomplete.ts
bun --check ./pi-skills-autocomplete.ts
pi -e ./pi-skills-autocomplete.ts
```

## Notes

- The extensions intentionally avoid changing core OMP/TUI or plain `pi` code.
- OMP and plain `pi` remain separate files and installation paths.
- OMP imports from `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`.
- plain `pi` imports types from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- Both targets inject skill context as hidden context while preserving the visible prompt as normal user text.
