#!/usr/bin/env node

// Совместимый launcher. Реализация Ralph находится в scripts/ralph, но остаётся
// частью защищённого control plane: продуктовый AFK-цикл не имеет права менять её.
import { runCli } from "../scripts/ralph/ralph-loop.mjs";

await runCli();
