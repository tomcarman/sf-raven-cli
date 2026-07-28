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

# flags.target-org.summary

Login username or alias for the target org. Uses the default org when omitted.

# flags.file.summary

Path to the anonymous Apex file to execute.

# flags.filter.summary

Only show USER_DEBUG lines containing this string. Errors and exceptions are always shown.

# flags.raw.summary

Print the full log body instead of filtering to USER_DEBUG and exception lines.

# info.executing

Executing anonymous Apex...

# info.fileCreated

Created %s.

# prompt.createFile

%s does not exist. Create it?

# error.noTargetOrg

No target org found. Specify one with --target-org or set a default org.

# error.fileNotFound

Apex file not found: %s
