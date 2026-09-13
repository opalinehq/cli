import {
	getCliDistinctId,
	getNextCliLoginAttemptNumber,
	identifyCliProductAnalyticsUser,
	resetCliProductAnalyticsIdentity,
	shutdownCliProductAnalytics,
	trackCliFirstRun,
} from "../../lib/product-analytics.js";

switch (process.argv[2]) {
	case "first-run":
		trackCliFirstRun({ commandName: "help", isAuthenticated: false });
		break;
	case "login-attempt":
		console.log(getNextCliLoginAttemptNumber());
		break;
	case "identity": {
		const before = getCliDistinctId();
		identifyCliProductAnalyticsUser("analytics-test-account-a");
		identifyCliProductAnalyticsUser("analytics-test-account-b");
		const switched = getCliDistinctId();
		resetCliProductAnalyticsIdentity();
		const loggedOut = getCliDistinctId();
		console.log(JSON.stringify({ before, switched, loggedOut }));
		break;
	}
	default:
		throw new Error("Unknown analytics probe");
}

await shutdownCliProductAnalytics();
