<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-ocr-review@main/icon.svg" width="96" height="96" alt="dsh-ocr-review logo" />
</p>

<h1 align="center">dsh-ocr-review</h1>

<p align="center"><em>The external `ocr` (open-code-review) CLI as seven dsh model tools and one settings card — you install the CLI, the plugin only discovers, verifies and drives it.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-ocr-review"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-ocr-review?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-ocr-review"><img src="https://img.shields.io/npm/d18m/@jayyuen66/dsh-ocr-review?style=flat-square" alt="npm downloads (total)" /></a>
  <a href="https://github.com/JayYuen666/dsh-ocr-review/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-ocr-review/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.3-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,nodejs,react,vitest,githubactions" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.zh-CN.md"><img src="https://img.shields.io/badge/lang-简体中文-658EFF?style=flat-square" alt="简体中文" /></a>
</p>

**A code-review bridge for [dsh](https://github.com/deepseek-ai/deepseek-harness): seven model tools (`ocr_review`, `ocr_scan`, delegate preview & rule, `ocr_session`, `ocr_rules_check`, `ocr_llm`) plus a settings card that applies the host's provider/model selection to the external CLI's own config — as a runtime command, never a plaintext key.**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Contents

- [What it does](#what-it-does)
- [Install](#install)
- [The external CLI](#the-external-cli)
- [Verify it is live](#verify-it-is-live)
- [What it does not provide](#what-it-does-not-provide)
- [Enabling it in dsh](#enabling-it-in-dsh)
- [Tools exposed to the model](#tools-exposed-to-the-model)
- [Settings](#settings)
- [Public interface](#public-interface)
- [Credentials and the OCR config file](#credentials-and-the-ocr-config-file)
- [Background runs as host jobs](#background-runs-as-host-jobs)
- [Data and privacy](#data-and-privacy)
- [Known boundaries](#known-boundaries)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does

- **One settings card also carries the admin surfaces**: a validated MCP servers JSON editor (saving touches only `mcp_servers`) and a ChatGPT section that reports `ocr auth` status and switches OCR's provider/model. Both are human-managed; neither is a model tool (a stdio MCP server runs commands, and OAuth sign-in needs a browser plus a local callback).
- **Wraps the external `ocr` (open-code-review) CLI into seven model tools.** The host validates tool arguments not at all, so every shape, type and enum gate lives in this package: user-controlled strings are single-quote escaped, enums are whitelist-clamped, and wrong-typed values error instead of silently narrowing or widening a review.
- **One settings card** (the web client half) picks provider/model from the host's own `llm-pi-ai` settings entry and key status from the host credentials service. When either service is absent the card shows the degradation reason; tools and settings keep working.
- **Applying a selection writes the CLI's own `~/.opencodereview/config.json`** — as an `api_key_cmd` command that reads the host credential ref at OCR runtime. A plaintext key is never written anywhere.
- **Results are a structured summary with two distinct notions**: what OCR found (`status`, `aggregation`, `topComments`, `warnings`) and whether the run actually covered the selected files (`coverage`, `budgetExceeded`, `toolCalls`). The CLI is invoked with `--audience agent`, which suppresses its progress output — the second notion is only reachable through those fields.
- **CLI availability is one judgement** (`resolveOcrAvailability` in `lib/cli.ts`): pure filesystem, never a spawn, re-read per call. The card status row, the detail-page badge and the activation guidance all render that one answer, so "which copy is in use" cannot be told three ways.
- **Background runs (`wait: false`) are official host jobs**: `job_list` / `job_output` / `job_kill` can observe and stop a review that outlives the tool call.

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Install

```sh
dsh plugin --profile web add @jayyuen66/dsh-ocr-review
```

Remove with `dsh plugin --profile web remove @jayyuen66/dsh-ocr-review`. The package is on the public npm registry, so installation needs no credentials.

- **Upgrading an installed copy is remove-then-add.** On a profile running HMR (the shipped ones do), `add` on a package the profile already depends on refuses before pnpm runs (`already-installed`) — run `remove` first, then `add` the target version; the new one starts without a restart. Without HMR the same `add` runs pnpm and reports `restart-required`.
- **Requires Node.js `>= 22.12` and host `dsh` on the `0.2.1-rc.3` line.** The host reads `engines.dsh` (`^0.2.1-rc.3`) and decides on it alone; prereleases participate in the comparison. An incompatible host needs the explicit risk grant `dsh plugin --profile <p> allow-version @jayyuen66/dsh-ocr-review@<version> --dsh-version <exact> --accept-risk`. The support window rolls: this package is verified against the three most recently released host versions at publish time and re-verified once the window moves, so the version number in this bullet is not a standing promise.
- **No `@deepseek-ai/*` under `dependencies`, by contract** (`test/publish-manifest.test.ts` enforces it). Consumer profiles install with `nodeLinker: hoisted` and `autoInstallPeers: false`, so a host package there is materialized as a real directory next to the copy the running host already loaded. `@deepseek-ai/dsh-tools` keys its scheduler with a plain `Symbol` (not `Symbol.for`), so symbol identity is per instance and **every native tool call in that profile throws** — while this package's build, typecheck and coverage gates stay green right up to that moment.
- **The five host packages `host.js` imports as values are required peers**: `@deepseek-ai/schemastery` (the host fork — only it resolves `.volatile()` fields), `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-atomic-write` and `@deepseek-ai/dsh-typert-protocol` (the Remote service base). Each is repeated in `devDependencies` at the same pin so this repository's own typecheck resolves them; the build externalizes all manifest tables, keeping bare specifiers in the artifact.
- **What ships**: `host.js`, `client.js`, `cordis.patch.yml`, `scripts/`, `icon.svg`, `CHANGELOG.md` and `THIRD_PARTY_NOTICES.md`. `prepack` rebuilds the bundles, so nothing stale is published.

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Shared version floor

If your profile pins `@jayyuen66/dsh-plugin-shared` with a pnpm `overrides` entry, that pin must be at least the version this package declares. A lower pin installs a copy without the names imported at runtime, and the host then reports `N entries did not activate` together with `does not provide an export named ...` at boot — the package installs fine and never loads, and no per-repository CI run can see it.

## <img src="https://api.iconify.design/lucide/terminal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> The external CLI

This package spawns `ocr`; it never installs or upgrades it. The command contract is verified against **1.13.3** (`EXPECTED_OCR_CLI_VERSION` in `lib/cli.ts`, declared once as `ocrCliVersion` in package.json — tests pin the manifest, the code constant and both READMEs to the same string).

```sh
brew install open-code-review                        # the formula tracks the newest release
npm i -g @alibaba-group/open-code-review@1.13.3      # pinned to the version this plugin verifies against
```

- **brew cannot pin.** `homebrew/core` carries one stable formula and no versioned variant, so `brew install` / `brew upgrade` always yields whatever is newest upstream. The npm command is the only one that can carry the verified version.
- **PATH wins, and the refusal is honest.** Command resolution takes the first `ocr` on `PATH`, then a copy inside this package's own dependency tree (skipped on Windows — a shebang script pwsh/cmd cannot execute); with neither, the tools refuse before spawning and hand the model the install commands above with the version filled in. "How it was installed" is read off the real target of the `bin` symlink: npm-style under `node_modules`, a formula under `Cellar` / `Homebrew`, otherwise reported as unrecognised rather than guessed.
- **Version is measured, not assumed.** Reading it spawns `ocr version` (15 s wall clock, always with `OCR_NO_UPDATE=1`) — on the card's Detect button, and once at apply when `startupVerify` is on. Rendering a page never spawns: the card shows the last measurement, or nothing measured yet. A disagreement names both numbers, flips the badge and appends a note to the review summary's `hint`; it is never a hard failure, and this package runs no installer.
- **Upstream self-update is real.** The npm wrapper runs `npm i -g @alibaba-group/open-code-review@<latest>` during invocations on its own. The version probe always suppresses that; `ocrNoAutoUpdate` extends the suppression to every command this package spawns (see Settings).
- **Upgrading from a release that bundled the CLI** (`optionalDependencies`, up to and including 0.1.5-rc): nothing to do — PATH now wins, so the stale copy stops shadowing yours. To clean the profile's tree, remove the package there and delete the `allowBuilds` entry that release needed in the profile's `pnpm-workspace.yaml`.
- **Platforms.** macOS and Linux are the targets: the process reaper and the `HOME=` injection behind a custom `ocrConfigPath` are POSIX-only. Windows runs the bare command without reaping (a hard host exit can leave an orphaned OCR process) and requires a global `ocr` on PATH.

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Verify it is live

1. **Mounted**: `dsh --profile web --dump-config` ends with this package's layer (`# == @jayyuen666/dsh-ocr-review`).
   - That command is the only accepted "it is in the layer stack" signal, and it is **not read-only** — it rewrites the profile's root assembly file. Read layer lines from stdout **and** check stderr separately: an unmatched patch target appears only on stderr, so the exit code alone proves nothing. Accept both `# == <layer>` and `# == <layer>, patched by <path>`.
2. **The card renders**: the settings page shows the card, and its External CLI row names which copy is in use, how it was installed, and which version this plugin verifies against.
3. **Detect version works**: pressing it runs one `ocr version` and fills the measured version into the row — or names the failure arm (command missing, non-zero exit, timeout, nothing parseable).
4. **Tools answer honestly without the CLI**: on a machine with no `ocr`, `ocr_review` refuses before spawning and returns the install commands with the verified version — not an exit-127 to reverse-derive.

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> What it does not provide

- **It does not install or upgrade the CLI.** The brew/npm commands are shown, never run; there is no update action and no clipboard API (a non-secure context would fail silently, looking like a dead button).
- **No HTTP route of its own.** The data plane is one official Typert Remote namespace (`ocrReview`) through the host `/api` gateway; authentication, Host / DNS-rebinding / Origin checks and body limits are the gateway's. This package holds no CSRF token, no body cap and no route disposer.
- **No CLI subcommand.** `dsh ocr …` does not exist.
- **It reads no file outside** the CLI's config path, the temp files it creates itself, and the host settings / credentials services it is handed.
- What it *does* consume: the host `settings` and `credentials` services (provider list, key status), `shell` (every `ocr` subprocess), `jobs` (background runs) and `systemPrompt` (one routing section). A missing settings or credentials service degrades the card only — the tools keep working.

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Enabling it in dsh

- `dsh.bundle.patch` in `package.json` points at `cordis.patch.yml`, whose single registration line is `- id: ocr-review` with `name` set to the bare package name — the bare name is what makes the host scan the client half.
- The card needs a web profile (`dsh.client.platform: web`, `immediately: true`). The nine `ocrReview` methods are installed unconditionally on the apply fiber, so a host whose web layer never comes up (a TUI) still has the tools and settings.
- The gateway exposes the methods only to clients of this profile; this package adds nothing in front of it.
- Deployment defaults go on the registration line's `config:` (cordis validates through the exported `Config` schema); precedence: settings-card runtime value > line config > built-in default.

## <img src="https://api.iconify.design/lucide/hammer.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Tools exposed to the model

| Tool | Arguments and constraints |
| --- | --- |
| `ocr_review` | repo (absolute path, default = the session workspace), scope workspace/commit/branch (branch needs both from+to and is mutually exclusive with commit), effort, background, exclude, provider/model/resume — resume only with commit/branch; a workspace run cannot be resumed. preview (file-selection only), noFilter, maxGitProcs, rule/backgroundFile (repo-root files only), wait |
| Numeric group (review and scan) | concurrency / timeoutMinutes / maxTools / maxTokens / maxTokensBudget, mapped to `--concurrency` `--timeout` `--max-tools` `--max-tokens` `--max-tokens-budget`. Values pass through faithfully; min floors are 1 for concurrency and 0 for the rest, and non-integers or below-floor values error instead of clamping |
| `ocr_scan` | repo, path, exclude, batch none/by-language/by-directory, provider/model (the CLI's native shared flags), the same numeric group, preview, noPlan/noDedup/noSummary, resume, maxGitProcs, rule (repo-root file), wait. Whole-repo scanning, no git diff required |
| `ocr_delegate_preview` / `ocr_delegate_rule` | preview: repo, scope/commit/from/to, exclude, background, backgroundFile/rule/maxGitProcs. rule: repo plus paths — required, up to 200 entries, positional after `--`, each escaped — plus rule. Zero LLM cost on the OCR side: they return the file list and the rule groups |
| `ocr_session` | repo, action list/show/comments/compare/export, id, before/after (compare), severity/category (comments filter), limit — default 10; an explicit value must be an integer in 1–100 and out-of-range errors rather than clamping. compare returns the four buckets; export returns an HTML path |
| `ocr_rules_check` | repo, path (required), rule (repo-root file): print the winning rule layer, glob and body; no LLM call |
| `ocr_llm` | action providers/models: read-only LLM catalogue queries; no review and no connectivity test |
| List caps | exclude and path take up to 2000 entries each; exceeding the cap rejects the call. Entries are never silently dropped — "reviewed fewer files than the list" must not be reportable as success |

`wait: false` starts a background run with no host deadline (poll `ocr_session`; the subprocess is also an official job, see [Background runs as host jobs](#background-runs-as-host-jobs)), and the reaper guard takes the OCR process tree down when dsh exits in any way. Cancelling the tool call stops the corresponding background process.

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Settings

The namespace is the entry id `ocr-review`; the card fields are the `.volatile()` ones.

| Field | Values, default, use |
| --- | --- |
| `effort` | auto/low/medium/high, default auto; `auto` omits `--effort` so OCR's own configured effort wins. Used when `ocr_review` is called without an explicit effort |
| `language` | 中文/English, default 中文; written as the top-level `language` key of the CLI config when a selection is applied |
| `autoVerify` | default true; a successful select also runs `ocr llm test` (capped by `llmTestTimeoutMs`) |
| `maxComments` | default 12, the number of comments kept in the summary; 0 = no truncation, non-integers and negatives fall back to 12 |
| `timeoutMinutes` | default 0 = request the host cap (the host clamps to min(request, shell.maxTimeoutMs)); above 0 is a number of minutes |
| `ocrConfigPath` | Where the CLI config lives; empty derives `<home>/.opencodereview/config.json`, `~` and `~/` prefixes accepted, relative paths error. A custom value must follow the `<X>/.opencodereview/config.json` layout — the CLI has no file-level path override, so the plugin injects `HOME=<X>` into the subprocess (config and sessions redirect together); anything else is rejected at the setting layer. POSIX-only: Windows has no such channel |

The deployment keys below are deliberately **not** on the card — they are plain (non-volatile) fields of the exported `Config`, settable only on the profile's `config:` line and taking effect on restart:

| Key | Default | Use |
| --- | --- | --- |
| `llmTestTimeoutMs` | `90000` | Wall clock for `ocr llm test`, shared by autoVerify and the card's test connection; raise it on slow machines |
| `startupVerify` | `true` | Run the endpoint self-check (and one version measurement) at apply. The same switch governs both, because the criterion is "may a load spawn processes"; turn it off if loads must stay process-free |
| `ocrBackgroundMaxMs` | `0` | Backstop window for background reviews (registry wait to the deadline, then kill); 0 = no window — an owned run also ends when its session stops, while an agentless one ends only when the host exits, the plugin unloads or the job is killed |
| `stdoutMaxBytes` | `400000` | Shell executor stdout cap, shared by foreground and background runs (review results go through the `--output` temp file precisely to step outside it) |
| `ocrNoAutoUpdate` | `false` | true puts `OCR_NO_UPDATE=1` on every command this package spawns, stopping upstream's mid-review `npm i -g` of a newer release; false keeps upstream behaviour. The version probe sets the variable regardless |
| `ocrInstallHint` | `both` | Which install command to lead with when nothing is installed: `both` / `brew` / `npm`. A fallback, not an override — an existing copy is always described by its own source, because telling a formula user to run `npm i -g` leaves a second copy behind while PATH still resolves the old one. The npm command always carries the verified version; the brew one never can |

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Public interface

One official Typert Remote namespace, `ocrReview` (`OCR_REMOTE_NAMESPACE` in `lib/remote-shape.ts`), its nine methods marked programmatically in `host.ts`. The service registers at construction and is withdrawn with its fiber, so a hot reload cannot leave a stale namespace behind.

| Method | Input | Success payload |
| --- | --- | --- |
| `providers()` | — | `{providers (each with a hasKey boolean), current, getCredReady, source, endpointVerify, ocrBinary}` — never a key. `ocrBinary` carries the filesystem-only availability verdict plus the version context (`source`, `channel`, `expectedVersion`, `measuredVersion: string \| null`, `installHint`); reading this method never spawns |
| `select(request)` | `{provider, model}`, both must hit the list `describe()` returns | `{ok, applied, llmTest}` (`llmTest` is null when `autoVerify` is off) |
| `migrate()` | — | `{ok, migrated, skippedUnknown}` |
| `test()` | — | `{ok, output}` — `ok` is the **test verdict**, not whether the call ran; output is redacted first, then cut to 8000 characters |
| `probe()` | — | `{ok, version, expectedVersion, consistent, output, reason, changeText}` — one `ocr version` under a 15 s wall clock, with `OCR_NO_UPDATE=1`. `consistent` is three-state (`null` = nothing was measured, where claiming a mismatch would be claiming without evidence); `reason` names the failure arm; `changeText` carries the install/upgrade sentence only when there is a command to give |
| `mcp()` | — | `{ok, json}` — only the `mcp_servers` object as pretty JSON, never providers or keys |
| `saveMcp(request)` | `{json}` — raw JSON text, at most 64 KiB; stdio/remote entries are validated field by field | `{ok, count}` — writes only `mcp_servers`; other config is preserved |
| `auth()` | — | `{ok, output, loginCommand}` — read-only `ocr auth status --provider chatgpt`; sign-in itself stays a terminal action because it needs a browser and a local callback |
| `chatGpt(request)` | `{model}` | `{ok, model}` — sets `provider: "chatgpt"` and `providers.chatgpt.model`, writes no key |

Refusals answer `{ok: false, error, status}` where `status` is a **retained semantic code, not an HTTP status** (400 for an empty or off-list selection, 500 for a failed write or a missing credential script) — the number lets the tests pin which rule fired, and the client renders `error` only. There is deliberately no client-side wall clock on these calls: the timeout belongs to the gateway, and a second one in the card is how a slow write gets reported lost while it actually landed.

## <img src="https://api.iconify.design/lucide/key-round.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Credentials and the OCR config file

| Aspect | Fact |
| --- | --- |
| What lands in the config | A command, not a secret: `api_key_cmd` = `node '<path of scripts/get-cred.mjs in this package>' '<REF>' '<dsh data dir>'` — single-quote escaped on POSIX, double-quote escaped on Windows (the CLI runs credential commands through `cmd.exe` there). The data directory is the host's current resolved home, so get-cred's fallback layers stay correct when `HOME` is redirected; the REF name must satisfy the official ref-name rule or the command is refused |
| Layer order | get-cred reads the same three layers in the same order as the official credentials-local: `refs.<REF>` in the managed credentials file first, then the inherited process environment, then `$DSH_HOME/.env`. The host treats the managed file as the effective credential, so a wrong order fails silently — OCR authenticates against a different key than the card reports while both sides show success |
| Reachability gate | select and migrate refuse a key the CLI cannot read at runtime: dsh strips `KEY`/`PASSWORD`/`SECRET`/`TOKEN`-named and `DSH_`-prefixed variables from spawned shells, and the reviewed repository's `.env` is deliberately not read. Keys living only in the dsh process environment or the workspace `.env` resolve on the host side yet fail at OCR runtime — previously a silent "select succeeded, OCR 401". The refusal happens before any write and names the fix |
| Writes | Atomic replacement through the official atomic-write helper: a random-suffixed temp sibling, then rename, with 0600 on the new inode; the `.bak` backup is copied by this package before the rename. The whole read→decide→write span runs under the official file lock — a short-lived `config.json.lock` appears and is removed in `finally`. An existing config that is invalid JSON or not an object aborts the write instead of being treated as empty |
| `migrate()` | Replaces the plaintext `api_key` of custom provider entries with `api_key_cmd` and deletes the plaintext; entries whose key source is unreachable at CLI runtime (same gate as select) or whose `apiKeyEnv` is missing from settings are left untouched and listed in `skippedUnknown`; nothing is written when nothing migrated |
| `scripts/get-cred.mjs` | Spawned by the CLI itself; the only place in this package that still reads host credential files. When all three layers miss it exits non-zero and names every location it checked |

## <img src="https://api.iconify.design/lucide/hourglass.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Background runs as host jobs

| Aspect | Fact |
| --- | --- |
| What the model gains | `job_list` shows the review, `job_output` reads its stdout/stderr (non-consuming — it never steals bytes from the session reader), `job_kill` stops it. Results still come from the `ocr_session` record |
| No registry, no background | A host without the jobs service makes `wait: false` throw an error naming the missing piece instead of starting a subprocess nobody can observe; foreground runs are unaffected |
| Ownership | When the calling agent resolves to a live session, the job is started with that session as its `owner`; `job_list` / `job_output` / `job_kill` then only reach it from that session. A call with no live agent starts an agentless job |
| Capacity buckets | Owned jobs count against their owner's bucket; agentless jobs share the unowned bucket host-wide. Overflow refuses a new start, so one hung CLI can park a slot — the optional `ocrBackgroundMaxMs` backstop uses the registry's own wait + kill, not a host timer |
| Cleanup | Before each start, settled records of this kind visible to that caller (the shared unowned bucket plus the caller's own) are pruned to a fixed window; live and stopping records are never pruned (the registry answers overflow by refusing, not by killing somebody's review). A session disposal kills or removes only that session's jobs; unload reclaims everything, using a small id → owner ledger because the registry hides other owners' jobs |
| Exposure | An owned job is visible to, and killable by, its own session only. Agentless jobs remain visible to every caller — the residual exposure, present only when no live agent could be resolved |
| Nothing may throw | An error raised inside a host event handler takes the whole host process down, and the official package does not cover producers either — the cancel chain catches at two layers, each pinned by its own test |

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Data and privacy

| Aspect | Fact |
| --- | --- |
| Process boundary | The reviewed repository's paths and diff content go into the `ocr` child process, and the CLI sends them to the LLM endpoint configured in its own config.json — that egress is the review feature itself and does not pass through the dsh host. Plaintext keys never appear in tool results or Remote payloads; a value resolved by the host is used only to confirm "it resolves right now" and is discarded on the spot |
| Redaction | All raw CLI stdout/stderr leaving this package (failure details, llm test, parse-failure echoes, session passthrough) goes through `redactKeyMaterial()`: bearer and assignment forms strictly, the standalone-key form only with random-string features, so file paths handed to the model are not erased with it |
| On disk | Two places only: the CLI's `config.json` (plus its temp sibling, the `.bak` backup and the short-lived lock) and `ocr-review-*` / `ocr-scan-*` temp files, deleted right after reading. Pre-migration plaintext may persist in that `.bak` (mode 0600) — delete the backup yourself to be rid of it. Outside these two, the only writer is the CLI's own npm wrapper unless `ocrNoAutoUpdate` is on |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Known boundaries

- **Windows gets no reaper and no custom config path.** Both rest on a POSIX toolchain (bash traps, process-group semantics, the `HOME=` assignment prefix); on Windows the package runs the bare command un-reaped, and a hard host exit can leave an orphaned OCR process.
- **A version mismatch is never a hard failure.** A newer CLI usually works; both numbers are shown, the badge flips, and the summary's `hint` says so. This package never runs an installer.
- **Version reads cost a spawn** and never happen on render; the card shows the last measurement or nothing — a page render cannot install, update or probe anything.
- **The atomic-write lock timeout surfaces in English.** Contention past the official wait budget throws the official package's own timeout text — the one user-visible error here that bypasses the bilingual message table.
- **`partial` is a terminal success state.** Some files failed but coverage stands and the comments are valid; it is neither upgraded to success nor folded into failure.
- **Agentless background jobs are visible to every session** (see Background runs). A call that cannot resolve a live agent starts one; owned jobs are fenced to their session.

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> FAQ

| Question / symptom | Answer |
| --- | --- |
| Exit 0 was taken as a successful review | Exit 0 is not success: any `status` outside success / complete / partial / completed_with_warnings / completed_with_errors / skipped reports as failure. `partial` means some files failed while coverage and the comments stand. A parse failure echoes the first 500 redacted UTF-16 code units of the raw output |
| Did the summary cover everything? | Two notions, neither replaces the other. `droppedCount` / `invalidCommentCount` say whether **this summary** listed every comment (raise `maxComments` or set 0 and re-check). Whether **the run** covered the selected files is `coverage` (`selected` is the denominator, `failedItems` names the files with their reasons) plus `budgetExceeded` and `toolCalls` |
| `add` was refused with `already-installed` | HMR profiles refuse `add` on an already-installed package before pnpm runs — `remove` first, then `add` the target version (see Install) |
| What happens to background processes when dsh exits? | The reaper guard takes the review/scan process tree down with TERM→1s→KILL on any host exit (including kill -9 followed by adoption); cancelling the tool call stops the corresponding background process |
| Where might a plaintext key still sit? | Nowhere this package writes. A pre-migration config's plaintext may survive in the `.bak` produced by the first write after you migrate (mode 0600); delete that backup to be rid of it |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> Development

```sh
pnpm install
pnpm run check   # typecheck (both sides) → lint → client build → host build → tests with coverage → format
```

- Coverage thresholds are **100%** across four metrics over the surface `vitest.config.ts` opts into (`coverageInclude`: `host.ts` + `lib/**`); two areas are deliberately outside it: the client half (`src/**`) is exercised through the bundle and the settings-card tests, and `scripts/get-cred.mjs` is driven by process-level tests spawning a child (v8 coverage cannot see a child process) — its behavioral gate lives in `test/get-cred.test.ts`.
- Adding this package's **local directory** to a profile (`pnpm add <path>`) needs pnpm ≥ 12.3.0: earlier pnpm 12 releases resolve an unaliased local path as a registry package name (upstream #14437, fixed in 12.3.0). Installing from the registry is unaffected.
- Bundle freshness is pinned by `test/build-host.test.ts`: a stale `host.js` / `client.js` fails the suite. Never hand-edit the bundles; `prepack` rebuilds them.
- The plugin source is TypeScript loaded directly by the host's cordis loader (Node ≥ 22.18 type stripping); the bundles exist for the published npm surface.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> License

MIT. Source at [github.com/JayYuen666/dsh-ocr-review](https://github.com/JayYuen666/dsh-ocr-review). Issues go to that repository's tracker.

Runtime dependencies carry their own licenses; [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) records that artifact boundary and how to re-check it.
