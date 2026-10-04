import {
	acquireSpoolWriteLock,
	createRepositorySpoolEnv,
} from "../../lib/repo-spool.js";

// Holds the spool write lock of argv[2] and waits to be stopped by a signal,
// like a SessionStart hook its host ends while it writes a capture.
const spoolRoot = process.argv[2];
if (!spoolRoot) throw new Error("Missing spool root");
await acquireSpoolWriteLock(spoolRoot, createRepositorySpoolEnv(spoolRoot));
process.stdout.write("locked\n");
setInterval(() => undefined, 60_000);
