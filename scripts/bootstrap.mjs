#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const gitCommand = "git";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runGit(args) {
  runCommand(gitCommand, args, {
    cwd: rootDir,
    env: process.env,
  });
}

function runPnpm(args, options = {}) {
  runCommand(pnpmCommand, args, {
    cwd: rootDir,
    env: process.env,
    ...options,
  });
}

runGit(["submodule", "update", "--init", "--recursive", "apps/zcode-cli"]);

runPnpm(["install"]);

runPnpm(["prepare:desktop-runtime"]);

runPnpm(["run", "build:bootstrap"]);
