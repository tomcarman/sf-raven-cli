# summary

Tail Apex debug logs in real time.

# description

Stream Apex debug logs as they are written. Logs are filtered to show USER_DEBUG statements and exceptions by default. Use --raw to see the full log body.

If no active trace flag exists for the target user, you will be prompted to create one. Without an active trace flag, no logs will be captured.

# examples

Tail logs for the default org:

<%= config.bin %> <%= command.id %>

Tail logs for a specific org:

<%= config.bin %> <%= command.id %> --target-org dev

Tail logs for a specific user:

<%= config.bin %> <%= command.id %> --user admin@myorg.com

Only show debug lines containing a specific string:

<%= config.bin %> <%= command.id %> --filter MyDebugPrefix

Show full raw log output:

<%= config.bin %> <%= command.id %> --raw

# flags.target-org.summary

Login username or alias for the target org. Uses the default org when omitted.

# flags.user.summary

Username to tail logs for. Defaults to the current authenticated user.

# flags.filter.summary

Only show USER_DEBUG lines containing this string. Errors and exceptions are always shown.

# flags.raw.summary

Print the full log body instead of filtering to USER_DEBUG and exception lines.

# flags.no-trace.summary

Skip trace flag check. Use when managing trace flags externally.

# flags.ndjson.summary

Stream machine-readable NDJSON events, one JSON object per line. Implies no prompts, no spinner, and no colour; the trace flag is created automatically.

# flags.timeout.summary

Minutes to listen before exiting (3-30, the platform minimum is 3). Default: 3.

# info.connecting

Connecting to org...

# info.streaming

Tailing logs for %s. Press Ctrl+C to stop.

# info.traceActive

Trace flag active until %s.

# info.traceCreated

Trace flag created, active until %s.

# info.exiting

Exiting.

# info.timeout

Timed out waiting for logs.

# prompt.createTrace

No active trace flag found. Create one (expires in 24h)?

# error.noTargetOrg

No target org found. Specify one with --target-org or set a default org.

# error.noUsername

Could not determine username. Specify one with --user.
