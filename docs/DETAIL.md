# Open code review

Runs the external `ocr` command line over a change set, reports the comments it produces, and manages which model does the reviewing.

## What the card changes

- **Model** — `ocrProvider` and `ocrModel` are not stored settings: they project the host's model namespace, and entries without a usable key are shown but disabled. `chatGptModel` reflects the external CLI's own login state, which this plugin reads but does not own.
- **Review parameters** — `effort` (`auto`/`low`/`medium`/`high`) is how many review passes run: deeper review costs more time. `language` chooses Chinese or English output. `autoVerify` (on) runs `ocr llm test` after you pick a provider and model, so a wrong choice fails at pick time rather than at first review. `maxComments` (default 12; 0 means all, including comments that cannot be anchored to a line). `timeoutMinutes` (0 requests the host's ceiling; a positive value is minutes, still clamped by the host). `ocrConfigPath` — empty means `~/.opencodereview/config.json`; a non-empty value must be `<dir>/.opencodereview/config.json` and is honoured by redirecting `HOME` (POSIX only).

Six of these are read per call, so a change applies on the next review without restarting the host.

## Two separate things called MCP

The card's MCP-servers editor writes the **external `ocr` tool's own** configuration. It is unrelated to the `integrationMode` / `mcpPort` surface of the Scrapling plugin, and nothing in this plugin serves MCP itself.

## Restart-only values

`llmTestTimeoutMs` (90000), `startupVerify` (on: the endpoint self-check runs at load), `ocrBackgroundMaxMs` (0 = no backstop window), `stdoutMaxBytes` (400000), `ocrNoAutoUpdate` (false: upstream auto-upgrade stays on unless you say otherwise) and `ocrInstallHint` (`both`/`brew`/`npm`). Set them in the `config:` block of this plugin's row in `cordis.patch.yml`.

## What it needs from outside

The `ocr` command line, expected at version **1.13.3**; the expectation is declared in code and mirrored in the package's manifest and READMEs, so a mismatch is reported rather than papered over. Install paths are `brew install open-code-review` or `npm i -g @alibaba-group/open-code-review@1.13.3`. A missing binary is reported as "command not found"; the case where a launcher exists but the binary does not says exactly that. The version probe always forces `OCR_NO_UPDATE=1` so probing cannot trigger an upgrade.

API credentials are not stored here: the plugin writes a `api_key_cmd` that calls a helper script, so the key is fetched at run time instead of landing in a config file. If that script is missing, the card warns rather than sending an unauthenticated request.

## Further detail

The tool list exposed to the model, how background reviews become host jobs and the argument guard's flag table are in the package README (`README.md` / `README.zh-CN.md`).
