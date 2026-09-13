#!/usr/bin/env node
import { runCli } from "@opalinehq/cli/run";

await runCli(process.argv.slice(2));
