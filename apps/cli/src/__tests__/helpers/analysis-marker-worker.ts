import {
	removeAnalysisMarker,
	updateAnalysisMarker,
} from "../../lib/analysis-markers.js";

// Separate-process marker writer for the cross-process locking test:
// `merge <markerId> <memberId>` or `remove <markerId>`.
const [action, markerId, memberId] = process.argv.slice(2);
if (!markerId) throw new Error("marker id required");
if (action === "remove") {
	await removeAnalysisMarker({ markerId });
} else if (memberId) {
	await updateAnalysisMarker(
		{ markerId },
		{
			memberIds: [memberId],
			uploaded: { [memberId]: { mtimeMs: 1, size: 1 } },
		},
	);
}
