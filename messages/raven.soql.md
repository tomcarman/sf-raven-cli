# summary

Run SOQL queries in an interactive REPL, or one-shot from the shell.

# description

Without a query argument, starts an interactive REPL with multi-line input, per-org arrow-key history, an automatic LIMIT on unbounded queries, and automatic Tooling API fallback for setup entities. Results render as a table with a row number column; meta-commands (type \help) act on the last result - open a row in the browser, expand it to a full record view, export to CSV, and more. With a query argument, runs the query once through the same pipeline and prints it in the chosen format.

# examples

Start the REPL against the default org:

<%= config.bin %> <%= command.id %>

Start the REPL against a specific org:

<%= config.bin %> <%= command.id %> --target-org my-sandbox

Run a one-shot query:

<%= config.bin %> <%= command.id %> "SELECT Id, Name FROM Account WHERE CreatedDate = TODAY"

Run a one-shot query as CSV for a spreadsheet:

<%= config.bin %> <%= command.id %> "SELECT Id, Name FROM Account" --format csv

Run a one-shot query as JSON:

<%= config.bin %> <%= command.id %> "SELECT Id, Name FROM Account" --json

# args.query.description

SOQL query to run once; omit to start the interactive REPL.

# flags.target-org.summary

Login username or alias for the target org; defaults to the default org.

# flags.format.summary

Output format for one-shot mode: table, json (raw records array), csv, or toon (TOON-encoded records array).

# error.noTargetOrg

No target org found. Specify one with --target-org or set a default org.

# error.replJson

--json and --format only apply to one-shot mode. Pass a query argument, or set the format inside the REPL with \format.

# error.queryFailed

%s

# info.welcome

sf raven soql - type \help for meta-commands, \q or Ctrl+D to exit.

# info.connected

Connected to %s as %s.

# info.exiting

Goodbye.

# info.abandoned

Query abandoned.

# info.interruptHint

Press Ctrl+D or type \q to exit.

# info.limitSet

Auto-limit set to %s.

# info.limitDisabled

Auto-limit disabled.

# info.formatSet

Output format set to %s.

# info.toolingState

Tooling routing: %s.

# info.csvWritten

Wrote %s row(s) to %s.

# info.opening

Opening %s...

# info.editorUnchanged

Query unchanged.

# error.meta.unknown

Unknown command %s. Type \help for the list of meta-commands.

# error.meta.limit

Usage: \limit N - N must be a non-negative integer (0 disables the auto-limit).

# error.meta.format

Usage: \format <fmt> - one of: %s.

# error.meta.csv

Usage: \csv <path>.

# error.meta.fields

Usage: \fields <Object>.

# error.meta.row

Usage: %s <row#> - the 1-based row number from the last result table.

# error.meta.tooling

Usage: \tooling [on|off|auto].

# error.noResult

No query result yet - run a query first.

# error.rowOutOfRange

Row %s is out of range - the last result has %s row(s).

# error.noIdColumn

The last result has no Id column, so the row cannot be resolved to a record.

# error.noEditor

$EDITOR is not set.

# error.noQueryToEdit

Nothing to edit yet - type a query first.

# error.editorFailed

The editor exited with an error; the query was not run.
