// Runs Obsidian's own review action (obsidianmd/obsidian-workflows) locally, in
// scanner mode, against the source tree and the built main.js — the same checks
// the community directory runs on every release. Build first: `npm run build`.
//
//   node scripts/review-check.mjs [--strict]
//
// The summary is written to reports/review-check.md. Exit code 1 on errors
// (or, with --strict, on any policy finding).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ACTION_REPO = "https://github.com/obsidianmd/obsidian-workflows.git";
const ACTION_COMMIT = "8167caed39664214d82c86fdfa32e06d8d55f61d"; // v1.2.3
const root = process.cwd();
const actionDir = path.join(root, "build", "obsidian-workflows");
const strict = process.argv.includes("--strict");

if (!fs.existsSync(path.join(root, "main.js"))) throw new Error("main.js not found: run `npm run build` first");

if (!fs.existsSync(path.join(actionDir, "dist", "index.js"))) {
	fs.mkdirSync(path.dirname(actionDir), { recursive: true });
	execFileSync("git", ["clone", "--quiet", ACTION_REPO, actionDir], { stdio: "inherit" });
}
execFileSync("git", ["-C", actionDir, "checkout", "--quiet", ACTION_COMMIT], { stdio: "inherit" });

const tmp = fs.mkdtempSync(path.join(root, "build", "review-"));
const summary = path.join(tmp, "summary.md");
const output = path.join(tmp, "output.txt");
fs.writeFileSync(summary, "");
fs.writeFileSync(output, "");

const res = spawnSync(process.execPath, [path.join(actionDir, "dist", "index.js")], {
	cwd: root,
	stdio: ["ignore", "pipe", "inherit"],
	encoding: "utf8",
	env: {
		...process.env,
		GITHUB_WORKSPACE: root,
		GITHUB_STEP_SUMMARY: summary,
		GITHUB_OUTPUT: output,
		INPUT_TYPE: "plugin",
		INPUT_MODE: "pr",
		INPUT_BUILD: "false",
		INPUT_LINT: "true",
		"INPUT_SCANNER-LINT": "true",
		INPUT_STRICT: String(strict),
		"INPUT_NODE-VERSION": "24",
	},
});

const md = fs.readFileSync(summary, "utf8");
// GITHUB_OUTPUT uses the heredoc form: validation-passed<<delim \n false \n delim
const failed = /validation-passed<<\S+\r?\nfalse/.test(fs.readFileSync(output, "utf8"));
fs.writeFileSync(path.join(root, "reports", "review-check.md"), md);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(md.split("\n").find((l) => l.startsWith("**Overall:**")) ?? "no summary");
console.log("full report: reports/review-check.md");
process.exit(failed || res.status ? 1 : 0);
