# Obsidian workflow results

**Advisory mode:** policy findings are reported as warnings. Set `strict: true` to fail the build on them.

**Overall:** Passed · **Errors:** 0 · **Warnings:** 1 · **Recommendations:** 1 · **Inconclusive:** 0

## repository metadata

| Rule ID | Severity | Status | Location | Message | Remediation |
| --- | --- | --- | --- | --- | --- |
| repository-metadata-unavailable | warning | skipped | — | Repository metadata checks were skipped because GITHUB_TOKEN is not set. | — |

## artifact-preflight

| Rule ID | Severity | Status | Location | Message | Remediation |
| --- | --- | --- | --- | --- | --- |
| bundle-inline-wasm | warning | failed | main.js | The bundle contains inline base64 data with a WebAssembly magic header. | This is an advisory preflight check; the authoritative scan runs at release against the published bundle. main.js bundles dependencies, so this finding may originate from a third-party package rather than the author’s own source. |
| bundle-wasm-reference | recommendation | failed | main.js | The bundle references WebAssembly file(s): ort-wasm-simd-threaded.wasm, ort.wasm, .wasm, ?!Qe.wasm, :Nl(r.wasm, env.wasm, l=n?.wasm, {gh(e.wasm, !!Ie.wasm, !n.in.wasm, &&(n.in.wasm, Nl(Ie.wasm, Ie.wasm, \|\|Ie.wasm, &&(Ie.wasm, e=Ie.wasm, \|\|!Number.isInteger(Ie.wasm, We?.wasm, &&We?.wasm, &&We?.wasm?.wasmPaths?.wasm. | This is an advisory preflight check; the authoritative scan runs at release against the published bundle. main.js bundles dependencies, so this finding may originate from a third-party package rather than the author’s own source. |

## scanner-stylelint

| Rule ID | Severity | Status | Location | Message | Remediation |
| --- | --- | --- | --- | --- | --- |
| scanner-stylelint-passed | recommendation | passed | — | Scanner Stylelint found no issues. | — |

## scanner-eslint

| Rule ID | Severity | Status | Location | Message | Remediation |
| --- | --- | --- | --- | --- | --- |
| scanner-eslint-passed | recommendation | passed | — | Scanner ESLint found no issues. | — |

## Coverage

| Check | Coverage | Reason |
| --- | --- | --- |
| Repository and manifest checks | Checked here | Source files are available in this run |
| Community scanner parity | Partial | Public rules only; private heuristics are unavailable |
| plugin-releases | Deferred to release | Published release and build verification require release metadata |
| plugin-network | Partial | partial — advisory, authoritative scan runs at release |
| plugin-behavior | Partial | partial — advisory, authoritative scan runs at release |
| plugin-es5 | Partial | partial — advisory, authoritative scan runs at release |
| plugin-obfuscation | Deferred to release | Private thresholds; only partial parity is possible |
| plugin-wasm | Partial | partial — advisory, authoritative scan runs at release |
| plugin-funding | Deferred to release | Analyzes the published main.js bundle |

These checks mirror a subset of the community directory scanner. Passing here does **not** guarantee directory acceptance. Some checks remain fully deferred until a published release exists.

Action version: 1.2.3 · Rule-catalog version: eslint-plugin-obsidianmd@0.4.1; local-rules@1
