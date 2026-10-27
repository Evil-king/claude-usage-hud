#!/usr/bin/env node
/**
 * ensure-statusline.mjs — re-assert the usage-hud bridge as Claude Code's
 * statusline command.
 *
 * Why this exists: a Claude Code session loads settings.json once and can write
 * its in-memory copy back on exit. A session that started before the bridge was
 * installed therefore reverts the edit, and the next session silently runs the
 * old statusline again. Running this at SessionStart turns that race into a
 * one-render blip at worst: every session begins with the bridge in place.
 *
 * The previous command is preserved in usage-hud.json's `chainCommand`, so the
 * re-assertion never drops whatever the user had before.
 *
 * Silent by design: a statusline hook must not print into the session.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim() !== "" ? process.env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
const SETTINGS = join(HOME, "settings.json");
const CONFIG = join(HOME, "usage-hud.json");
const BRIDGE = join(HOME, "usage-hud", "statusline.mjs");

/** The command every session should run. */
const COMMAND = `node ${BRIDGE}`;

try {
	if (!existsSync(SETTINGS)) process.exit(0);
	const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
	const current = typeof settings?.statusLine?.command === "string" ? settings.statusLine.command : "";
	if (current === COMMAND) process.exit(0);
	// Keep whatever command is being replaced so the bridge can chain it.
	if (current !== "" && !current.includes("usage-hud/statusline.mjs")) {
		let config = {};
		try {
			config = JSON.parse(readFileSync(CONFIG, "utf8"));
		} catch (_noConfig) {
			// First run: start the file from scratch.
		}
		config.chainCommand = current;
		writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	}
	settings.statusLine = { type: "command", command: COMMAND };
	writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
} catch (_unwritable) {
	// An unreadable or read-only settings file is not worth a session failure.
}
