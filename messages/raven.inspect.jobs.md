# summary

Show async and scheduled jobs running in an org.

# description

Prints two sections. Async jobs covers the org's asynchronous Apex: everything currently in flight (Holding, Queued, Preparing, Processing) plus anything that finished in the last 24 hours, newest first. Widen the finished-job window with --since and raise the 50-row cap with --limit. Failed jobs print their extended status beneath the row.

Scheduled jobs lists every CronTrigger, soonest next run first, with the cron expression rendered to English. Jobs that will never fire again sink to the bottom, and any job not in the WAITING state is marked on its row.

# examples

Show jobs for the default org:

<%= config.bin %> <%= command.id %>

Show jobs for a specific org:

<%= config.bin %> <%= command.id %> --target-org dev

Include everything that finished in the last three days:

<%= config.bin %> <%= command.id %> --since 3d --limit 200

# flags.target-org.summary

Login username or alias for the target org.

# flags.since.summary

How far back to include finished jobs, as a number followed by m, h, or d (for example 90m, 2h, 3d).

# flags.limit.summary

Maximum number of rows to return.

# label.asyncJobs

Async jobs

# label.scheduledJobs

Scheduled jobs

# info.loading

Loading jobs...

# info.noAsyncJobs

No jobs in flight, and none finished in the last %s.

# info.noScheduledJobs

Nothing is scheduled in this org.

# error.badSince

Could not read "%s" as a time window. Use a number followed by m, h, or d, for example 2h or 3d.
