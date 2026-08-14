#!/usr/bin/env node

// Совместимый launcher. Изменяемая реализация Ralph находится вне защищённой
// папки инструкций, чтобы Codex workspace-write мог исправлять её по review-issues.
import { runCli } from "../scripts/ralph/ralph-loop.mjs";

await runCli();
