# summary

Execute an anonymous Apex file and print clean debug output.

# description

Runs an anonymous Apex file against the target org and prints the resulting debug log, filtered to USER_DEBUG statements and exceptions by default.

Execution uses the SOAP debugging header, so each run's log is returned with the result. No trace flag is needed and logs from other org activity are never mixed in.

The command exits non-zero when the code fails to compile or throws at runtime, so it can be used in scripts.

# examples

Run the default scratch file against the default org:

<%= config.bin %> <%= command.id %>

Run a specific file against a specific org:

<%= config.bin %> <%= command.id %> --file scripts/apex/backfill.apex --target-org dev

Only show debug lines containing a specific string:

<%= config.bin %> <%= command.id %> --filter MyDebugPrefix

Show the full raw log body:

<%= config.bin %> <%= command.id %> --raw

Re-run the file every time it is saved:

<%= config.bin %> <%= command.id %> --watch

Stream machine-readable results from a watch loop:

<%= config.bin %> <%= command.id %> --watch --ndjson

Log SOQL, DML and method entry and exit as well as debug lines:

<%= config.bin %> <%= command.id %> --log-detail fine

Keep one process running and send it runs on stdin, one JSON line each:

echo '{"id": "1", "code": "System.debug(1);"}' | <%= config.bin %> <%= command.id %> --stdin --ndjson

# flags.target-org.summary

Login username or alias for the target org. Uses the default org when omitted.

# flags.file.summary

Path to the anonymous Apex file to execute.

# flags.filter.summary

Only show USER_DEBUG lines containing this string. Errors and exceptions are always shown.

# flags.raw.summary

Print the full log body instead of filtering to USER_DEBUG and exception lines.

# flags.watch.summary

Re-run the file every time it changes on disk. Press Ctrl+C to stop. Cannot be combined with --json.

# flags.ndjson.summary

Stream machine-readable NDJSON events, one JSON object per line, instead of formatted output. Requires --watch or --stdin.

# flags.stdin.summary

Read run requests from stdin, one JSON line each ({"id": "...", "code": "...", "logDetail": "fine"}, logDetail optional), and run them one at a time until stdin closes. Nothing runs at startup. Requires --ndjson. Cannot be combined with --file, --watch or --json.

# flags.log-detail.summary

How much the debug log records. debug logs debug lines and limits only. fine adds SOQL, DML and method entry and exit. finest logs everything, including variable assignments and statements. In --stdin mode a request's "logDetail" field overrides this flag.

# info.executing

Executing anonymous Apex...

# info.fileCreated

Created %s.

# info.watching

watching %s

# info.exiting

Exiting.

# prompt.createFile

%s does not exist. Create it?

# error.noTargetOrg

No target org found. Specify one with --target-org or set a default org.

# error.fileNotFound

Apex file not found: %s

# error.watchWithJson

--watch cannot be combined with --json. Use --ndjson for machine-readable watch output.

# error.ndjsonRequiresWatch

--ndjson requires --watch or --stdin.

# error.stdinRequiresNdjson

--stdin requires --ndjson.

# error.stdinExclusive

--stdin cannot be combined with --file, --watch or --json.
