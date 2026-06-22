# Agent Guide: `$skill` Autocomplete Extensions

This repository packages and maintains `$skill` autocomplete extensions for two targets:

- **Oh My Pi / OMP** — `omp-skills-autocomplete.ts`.
- **plain `pi`** — `pi-skills-autocomplete.ts`.

Keep target-specific implementation details in the target guide files:

- `OMP_EXTENSION.md` — OMP custom editor, renderer compatibility path, `before_agent_start` hidden context, deployment, verification, and regression history.
- `PI_EXTENSION.md` — plain `pi` native provider stacking, `before_agent_start` hidden context, deployment, verification, and non-goals.

## Repository layout

```text
omp-skills-autocomplete.ts  # OMP extension source
pi-skills-autocomplete.ts   # plain pi extension source
README.md                   # Human usage and installation guide
AGENTS.md                   # General development guide for AI agents
OMP_EXTENSION.md            # OMP-specific implementation guide
PI_EXTENSION.md             # plain pi-specific implementation guide
```

## Source of truth

During development, edit repository copies first:

```text
<repo>/omp-skills-autocomplete.ts
<repo>/pi-skills-autocomplete.ts
```

Do not silently patch only installed copies unless the user explicitly asks for a hotfix. If debugging against an installed extension, keep the repository copy and installed copy synchronized intentionally.

## Target guide requirement

Before changing a target-specific file, read the matching guide:

- Changing `omp-skills-autocomplete.ts` or OMP behavior: read `OMP_EXTENSION.md`.
- Changing `pi-skills-autocomplete.ts` or plain `pi` behavior: read `PI_EXTENSION.md`.
- Changing shared docs or repo workflow: read this file and any target guide touched by the change.

## Deployment paths

OMP installed path:

```text
$HOME/.omp/agent/extensions/skills-autocomplete.ts
```

Plain `pi` installed path:

```text
$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts
```

Windows paths used on this workstation:

```text
C:/Users/SU/.omp/agent/extensions/skills-autocomplete.ts
C:/Users/SU/.pi/agent/extensions/pi-skills-autocomplete.ts
```

Bash deployment from repository root:

```bash
cp ./omp-skills-autocomplete.ts "$HOME/.omp/agent/extensions/skills-autocomplete.ts"
cp ./pi-skills-autocomplete.ts "$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

If `$HOME` is unavailable in the shell, use the explicit Windows paths above.

PowerShell deployment from repository root:

```powershell
Copy-Item .\omp-skills-autocomplete.ts "$env:USERPROFILE\.omp\agent\extensions\skills-autocomplete.ts" -Force
Copy-Item .\pi-skills-autocomplete.ts "$env:USERPROFILE\.pi\agent\extensions\pi-skills-autocomplete.ts" -Force
```

## Verification matrix

After changing `omp-skills-autocomplete.ts`, run at minimum:

```bash
bun --check ./omp-skills-autocomplete.ts
```

After changing `pi-skills-autocomplete.ts`, run at minimum:

```bash
bun --check ./pi-skills-autocomplete.ts
pi -e ./pi-skills-autocomplete.ts
```

After copying to installed OMP path, run:

```bash
bun --check "$HOME/.omp/agent/extensions/skills-autocomplete.ts"
omp -p --no-tools --max-time=5 "/skills-autocomplete-status"
```

After copying to installed plain `pi` path, run:

```bash
bun --check "$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts"
pi -e "$HOME/.pi/agent/extensions/pi-skills-autocomplete.ts"
```

Use explicit Windows paths if `$HOME` resolves incorrectly.

Behavior changes require focused smoke tests that cover the changed branch. See the target-specific guide for required smoke scenarios.

## Development flow

1. Identify the affected target: OMP, plain `pi`, or docs-only.
2. Read the matching target guide before editing.
3. Reuse existing behavior and naming. Do not introduce a second convention beside an existing one.
4. Keep the two entrypoints separate unless a shared extraction is explicitly planned and verified for both targets.
5. Make surgical edits in repository files first.
6. Run target-specific checks.
7. Deploy to installed path only when the user asks for local installation/hotfix or the task explicitly requires it.
8. Verify the installed copy after deployment.
9. Update docs when behavior, deployment, verification, or regression knowledge changes.

## Target separation

OMP and plain `pi` APIs are not identical. Keep runtime imports isolated by entrypoint:

- OMP imports from `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`.
- plain `pi` imports types from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.

Shared code may be extracted later only if both entrypoints keep runtime imports isolated and both target guide verification suites pass.

Do not create shared runtime dependencies that make one target require the other's packages.

Do not break OMP behavior while changing plain `pi`, and do not change plain `pi` behavior while fixing OMP unless explicitly required.

## Documentation rules

- Keep user-facing usage/install instructions in `README.md`.
- Keep OMP internals, renderer compatibility path, hidden-context rules, and OMP regression history in `OMP_EXTENSION.md`.
- Keep plain `pi` internals, lifecycle, provider stacking, and non-goals in `PI_EXTENSION.md`.
- Keep cross-target workflow, deployment map, and harness-specific notes in `AGENTS.md`.
- When a bug is fixed, add the regression note to the target-specific guide, not only to chat history.

## Harness-specific files

These files are intended for agent/harness use and should stay concise but actionable:

```text
AGENTS.md         # general agent workflow and repo rules
OMP_EXTENSION.md  # OMP-specific agent handoff/reference
PI_EXTENSION.md   # plain pi-specific agent handoff/reference
```

Do not put long target-specific implementation contracts back into `AGENTS.md`; link or point to the target guide instead.

## Style rules

- Prefer plugin-local fixes over core OMP/TUI or plain `pi` changes.
- Keep behavior boring and explicit.
- Do not add speculative options/configuration without a user request.
- Do not replace exact `$` wording with placeholders such as `{DOLLAR}`.
- Keep user-facing docs concise; put deep implementation notes in the target guides.
