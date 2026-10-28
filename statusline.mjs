#!/usr/bin/env node
/**
 * claude-usage-hud — a Claude Code statusline bridge.
 *
 * Reads the statusline JSON Claude Code pipes in, prints one usage line
 * (model · session tokens · estimated cost · GLM plan quota), then replays the
 * same JSON into the chained statusline command (e.g. claude-hud) and prints
 * its output, so both rows stay live.
 *
 * Why a bridge and not a replacement: Claude Code gives one statusline slot.
 * Everything this script does is additive — the chain receives the byte-exact
 * stdin it would have received anyway.
 *
 * Config lives beside this file's home directory: ~/.claude/usage-hud.json
 * (never committed; holds the bigmodel.cn authorization header and the chain
 * command). Cache lives in ~/.claude/.usage-hud-cache.json; both are written
 * best-effort, because a statusline must never break the session.
 *
 * @module claude-usage-hud
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== "" ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
const CONFIG_PATH = join(HOME, "usage-hud.json");
const CACHE_PATH = join(HOME, ".usage-hud-cache.json");

/** ANSI helpers; the statusline disables colors when piped, but Claude Code is a TTY. */
const useColor = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0"
	|| (process.stdout.isTTY !== false && process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0");
/** Field labels: plain white — readable on dark palettes where dim vanishes. */
const label = (text) => (useColor ? `\u001b[97m${text}\u001b[0m` : text);
/** The model name: bold bright white, the row's anchor. */
const emphasis = (text) => (useColor ? `\u001b[1;97m${text}\u001b[0m` : text);
/** Pressure colors use the bright variants so they stay legible. */
const green = (text) => (useColor ? `\u001b[1;92m${text}\u001b[0m` : text);
const yellow = (text) => (useColor ? `\u001b[1;93m${text}\u001b[0m` : text);
const red = (text) => (useColor ? `\u001b[1;91m${text}\u001b[0m` : text);
/**
 * The branch mark: bold bright cyan.
 *
 * Plain `36` is theme-dependent — several dark palettes map ANSI cyan to a
 * muted grey. Bold + bright variant (96) reads as cyan even there.
 */
const cyan = (text) => (useColor ? `\u001b[1;96m${text}\u001b[0m` : text);

/** Token counts per 1M for the routes this machine actually serves, USD. */
const PRICES = {
	"glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
	"glm-5.3-highspeed": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	"deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15 },
	"deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 }
};

/** Context window per route family, tokens; a routed model defaults to 1M. */
const CONTEXT_WINDOWS = {
	"glm-5.3": 1e6,
	"glm-5.3-flash": 1e6,
	"glm-5.3-highspeed": 1e6,
	"deepseek-flash": 1e6,
	"deepseek-chat": 1e6
};

/** The window one model id carries: exact table, then family, then 200k. */
function contextWindowOf(model) {
	if (typeof model !== "string") return 200000;
	if (CONTEXT_WINDOWS[model] !== undefined) return CONTEXT_WINDOWS[model];
	if (/^glm-|^zai-/.test(model)) return 1e6;
	if (/^deepseek-/.test(model)) return 1e6;
	return 200000;
}

/** How long one quota answer stands on disk; the plan windows move slowly. */
const DEFAULT_QUOTA_TTL_S = 60;

/** Read a JSON file, tolerating absence and corruption. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (_missingOrBroken) {
		return undefined;
	}
}

/** Write a JSON file best-effort; a statusline must not fail over its cache. */
function writeJson(path, value) {
	try {
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	} catch (_unwritable) {
		// Read-only home or full disk: recompute next render instead.
	}
}

/** The user's config, with defaults. */
function readConfig() {
	const raw = readJson(CONFIG_PATH) ?? {};
	return {
		glmAuthorization: typeof raw.glmAuthorization === "string" ? raw.glmAuthorization.trim() : "",
		chainCommand: typeof raw.chainCommand === "string" ? raw.chainCommand : "",
		quotaTtlSeconds: Number.isFinite(Number(raw.quotaTtlSeconds)) ? Math.max(10, Math.min(3600, Math.round(Number(raw.quotaTtlSeconds)))) : DEFAULT_QUOTA_TTL_S,
		showCost: raw.showCost !== false
	};
}

/** Compact token count: 1234, 12.3k, 1.23M. */
function formatTokens(value) {
	if (value < 1e3) return String(value);
	if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
	return `${(value / 1e6).toFixed(2)}M`;
}

/** Money text with the precision the magnitude deserves. */
function formatMoney(value) {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
	return `$${value.toFixed(digits)}`;
}

/** The 5-hour window names a clock time; the weekly line names a date. */
function resetText(limit) {
	const at = Number(limit?.nextResetTime);
	if (!Number.isFinite(at) || at <= 0) return "";
	const date = new Date(at);
	const two = (value) => String(value).padStart(2, "0");
	if (limit.unit === 3) return `${two(date.getHours())}:${two(date.getMinutes())}`;
	return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** A share colored by pressure: calm under 70, watched under 90, loud after. */
function share(value) {
	const text = `${Math.round(value)}%`;
	return value < 70 ? green(text) : value < 90 ? yellow(text) : red(text);
}

/**
 * Sum one transcript's usage by model, deduplicated by assistant message id.
 *
 * The id is the unit Anthropic bills: a streamed message may be persisted more
 * than once, and counting each line would overstate the session.
 *
 * @param path - transcript JSONL path.
 * @returns `{tokens, cost, models}`; zeros when unreadable.
 */
function sumTranscript(path) {
	const empty = { tokens: 0, cost: 0, models: [], lastModel: "", lastPromptTokens: 0 };
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (_unreadable) {
		return empty;
	}
	const seen = new Set();
	const byModel = new Map();
	let tokens = 0;
	let cost = 0;
	let lastModel = "";
	let lastPromptTokens = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch (_torn) {
			continue;
		}
		const message = entry?.message;
		const usage = message?.usage;
		if (message === null || typeof message !== "object" || usage === null || typeof usage !== "object") continue;
		const id = typeof message.id === "string" ? message.id : undefined;
		if (id !== undefined) {
			if (seen.has(id)) continue;
			seen.add(id);
		}
		const input = Number(usage.input_tokens) || 0;
		const output = Number(usage.output_tokens) || 0;
		const cacheRead = Number(usage.cache_read_input_tokens) || 0;
		const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
		if (input + output + cacheRead + cacheWrite === 0) continue;
		tokens += input + output + cacheRead + cacheWrite;
		const model = typeof message.model === "string" ? message.model : "";
		const price = PRICES[model];
		if (price !== undefined) {
			cost += (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6;
		}
		byModel.set(model, (byModel.get(model) ?? 0) + input + output + cacheRead + cacheWrite);
		if (model !== "") lastModel = model;
		// The prompt of the most recent request is the live context size.
		lastPromptTokens = input + cacheRead + cacheWrite;
	}
	return { tokens, cost, models: [...byModel.entries()].sort((left, right) => right[1] - left[1]), lastModel, lastPromptTokens };
}

/**
 * Query the GLM Coding Plan quota, cached on disk for the configured TTL.
 *
 * The monitor endpoint is the same one the vendor's usage page reads; it
 * answers `{data: {limits, level}}`, with the 5-hour window at `unit: 3` and
 * the weekly line at `unit: 6`, each percentage being the share USED.
 *
 * @param config - the resolved config (token and TTL).
 * @returns `{limits, level, at}` or null when unavailable.
 */
async function readQuota(config) {
	if (config.glmAuthorization === "") return null;
	const cache = readJson(CACHE_PATH) ?? {};
	const now = Date.now();
	if (cache.quota !== undefined && Number.isFinite(cache.quotaAt) && now - cache.quotaAt < config.quotaTtlSeconds * 1000) {
		return cache.quota;
	}
	let quota = null;
	try {
		const response = await fetch("https://bigmodel.cn/api/monitor/usage/quota/limit", {
			headers: { authorization: config.glmAuthorization },
			signal: AbortSignal.timeout(4000)
		});
		if (response.ok) {
			const body = await response.json();
			const limits = Array.isArray(body?.data?.limits) ? body.data.limits : Array.isArray(body?.limits) ? body.limits : undefined;
			if (limits !== undefined) quota = { limits, level: typeof body?.data?.level === "string" ? body.data.level : null };
		}
	} catch (_unreachable) {
		// A dead network keeps the line short, not broken.
	}
	if (quota !== null) {
		cache.quota = quota;
		cache.quotaAt = now;
		writeJson(CACHE_PATH, cache);
	}
	return quota;
}

/**
 * The current branch of the workspace directory, when it is a git checkout.
 *
 * Walks up a handful of parents looking for `.git` — enough for a worktree or a
 * nested project — and reads HEAD directly, so no `git` process is spawned on
 * the render path.
 *
 * @param cwd - the workspace directory.
 * @returns the branch name, a short commit hash for a detached HEAD, or "".
 */
function gitBranch(cwd) {
	if (typeof cwd !== "string" || cwd === "") return "";
	let dir = cwd;
	for (let depth = 0; depth < 12; depth += 1) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				let headPath = join(gitPath, "HEAD");
				// A worktree or submodule stores `.git` as a file pointing at the
				// real git dir; follow it instead of giving up on the branch.
				if (!statSync(gitPath).isDirectory()) {
					const pointer = readFileSync(gitPath, "utf8").trim();
					if (pointer.startsWith("gitdir: ")) {
						const target = pointer.slice(8).trim();
						headPath = join(target.startsWith("/") ? target : join(dir, target), "HEAD");
					}
				}
				const head = readFileSync(headPath, "utf8").trim();
				if (head.startsWith("ref: ")) {
					const ref = head.slice(5);
					return ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
				}
				return head.slice(0, 8);
			} catch (_bareOrBroken) {
				return "";
			}
		}
		const parent = dir.slice(0, Math.max(dir.lastIndexOf("/"), 0));
		if (parent === "" || parent === dir) return "";
		dir = parent;
	}
	return "";
}

/** The statusline's first row: everything this bridge adds. */
function usageLine(stdinJson, config, quota) {
	const stdinModel = typeof stdinJson?.model?.display_name === "string" && stdinJson.model.display_name !== ""
		? stdinJson.model.display_name
		: typeof stdinJson?.model?.id === "string" ? stdinJson.model.id : "";
	const transcriptPath = typeof stdinJson?.transcript_path === "string" && stdinJson.transcript_path !== ""
		? stdinJson.transcript_path
		: latestTranscript();
	const summary = transcriptPath === undefined ? { tokens: 0, cost: 0, models: [], lastModel: "", lastPromptTokens: 0 } : sumTranscript(transcriptPath);
	// A payload without a model (a switch transient) names the one that last
	// served, so the row keeps saying what is being measured. The `[1m]` suffix
	// stays: it is what tells a 1M-context route from a 200k one, and two routes
	// of the same family are otherwise indistinguishable in the row.
	const model = (stdinModel === "" ? summary.lastModel : stdinModel).trim();
	// Claude Code's own cost covers Anthropic routes; a routed model it cannot
	// price reports 0, so the transcript estimate stands in only then.
	const stdinCost = Number(stdinJson?.cost?.total_cost_usd) || 0;
	const cost = stdinCost > 0 ? stdinCost : summary.cost;
	const parts = [];
	// Name and suffix are one token in the row, so they share one color.
	if (model !== "") parts.push(emphasis(model));
	// Pressing against the window is the one thing worth seeing at a glance.
	if (summary.lastPromptTokens > 0) {
		const window_ = contextWindowOf(summary.lastModel === "" ? model : summary.lastModel);
		const used = Math.min(100, Math.round((summary.lastPromptTokens / window_) * 100));
		parts.push(`${label("ctx")} ${share(used)}`);
	}
	if (summary.tokens > 0) parts.push(`${label("tok")} ${formatTokens(summary.tokens)}`);
	if (config.showCost === true && cost > 0) parts.push(`${label("≈")}${formatMoney(cost)}`);
	const limits = quota?.limits;
	if (Array.isArray(limits)) {
		const hourly = limits.find((limit) => limit.unit === 3);
		const weekly = limits.find((limit) => limit.unit === 6);
		if (hourly !== undefined) {
			const reset = resetText(hourly);
			parts.push(`${label("5h")} ${share(Number(hourly.percentage) || 0)}${reset === "" ? "" : label(`→${reset}`)}`);
		}
		if (weekly !== undefined) {
			const reset = resetText(weekly);
			parts.push(`${label("wk")} ${share(Number(weekly.percentage) || 0)}${reset === "" ? "" : label(`→${reset}`)}`);
		}
		if (typeof quota.level === "string" && quota.level !== "") parts.push(label(quota.level));
	}
	const branchDir = typeof stdinJson?.workspace?.current_dir === "string" && stdinJson.workspace.current_dir !== ""
		? stdinJson.workspace.current_dir
		: typeof stdinJson?.cwd === "string" && stdinJson.cwd !== "" ? stdinJson.cwd : process.cwd();
	const branch = gitBranch(branchDir);
	if (branch !== "") parts.push(cyan(`git:${branch}`));
	return parts.join("  ");
}

/** Run the chained statusline with the original stdin and return its output. */
function runChain(command, stdinText) {
	if (command.trim() === "") return "";
	try {
		return execFileSync("bash", ["-c", command], {
			input: stdinText,
			encoding: "utf8",
			timeout: 8000,
			env: process.env
		});
	} catch (_chainFailed) {
		// The chain is a courtesy: its failure must not hide this row.
		return "";
	}
}

/**
 * Append one compact diagnostic record, best-effort.
 *
 * A statusline that goes blank is only diagnosable from the inside: record what
 * arrived (model identity, whether a transcript was present, how much usage it
 * carried) and what was printed, then trim the file so it cannot grow forever.
 *
 * @param record - the fields to log.
 */
function logDebug(record) {
	const path = join(HOME, "usage-hud.log");
	try {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
		if (existsSync(path) && statSync(path).size > 256 * 1024) {
			writeFileSync(path, line, "utf8");
			return;
		}
		writeFileSync(path, line, { encoding: "utf8", flag: "a" });
	} catch (_unwritable) {
		// Diagnostics are a courtesy, never a failure path.
	}
}

/**
 * The newest transcript under this home's projects tree.
 *
 * A model switch can hand the statusline a payload without `transcript_path`
 * for a render or two; falling back to the session most recently written keeps
 * the row informative instead of collapsing to the quota segment alone.
 *
 * @returns the path, or undefined when the tree is unreadable.
 */
function latestTranscript() {
	try {
		const root = join(HOME, "projects");
		let best;
		let bestAt = 0;
		for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const path = join(entry.parentPath ?? entry.path, entry.name);
			let at;
			try {
				at = statSync(path).mtimeMs;
			} catch (_vanished) {
				continue;
			}
			if (at > bestAt) {
				bestAt = at;
				best = path;
			}
		}
		return best;
	} catch (_noProjects) {
		return undefined;
	}
}

/** Read all of stdin. */
function readStdin() {
	return new Promise((resolve) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", () => resolve(""));
	});
}

const stdinText = await readStdin();
let stdinJson;
try {
	stdinJson = JSON.parse(stdinText);
} catch (_noInput) {
	stdinJson = undefined;
}
const config = readConfig();
const quota = await readQuota(config);
const line = usageLine(stdinJson ?? {}, config, quota);
if (line !== "") process.stdout.write(`${line}\n`);
const chained = runChain(config.chainCommand, stdinText);
if (chained !== "") process.stdout.write(chained.endsWith("\n") ? chained : `${chained}\n`);
logDebug({
	stdinBytes: stdinText.length,
	parsed: stdinJson !== undefined,
	model: stdinJson?.model ?? null,
	// Which pane this render belongs to. Two Claude windows write to one log, and
	// without a session key their renders read as one session whose model flips.
	sessionId: typeof stdinJson?.session_id === "string" ? stdinJson.session_id : null,
	transcript: typeof stdinJson?.transcript_path === "string" ? stdinJson.transcript_path : null,
	hasTranscript: typeof stdinJson?.transcript_path === "string" && stdinJson.transcript_path !== "",
	costUsd: stdinJson?.cost?.total_cost_usd ?? null,
	quota: quota === null ? null : { level: quota.level, limits: quota.limits?.length ?? 0 },
	line,
	chainBytes: chained.length
});
