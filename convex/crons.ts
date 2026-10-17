import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Periodically pick up pending Agnes scene video generations and submit them every 2 minutes
crons.interval(
  "periodic-agnes-scene-submitter",
  { minutes: 2 },
  internal.submitter.runScheduledSubmission,
  {},
);

export default crons;
