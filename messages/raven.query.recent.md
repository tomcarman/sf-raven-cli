# summary

Show the most recently created records for an sObject.

# description

A zero-friction list view for poking at what just happened in an org: the newest records for an object, one row each.

By default you get the record Id, its name field, when it was created, and who created it. Use --modified to sort and report on last modification instead. --fields is additive: whatever you name is appended to those defaults rather than replacing them.

# examples

Show the 10 newest Accounts:

<%= config.bin %> <%= command.id %> Account

Show the 25 most recently modified Cases:

<%= config.bin %> <%= command.id %> Case --modified --limit 25

Add extra columns:

<%= config.bin %> <%= command.id %> Opportunity --fields StageName,Amount

Only look at one record type:

<%= config.bin %> <%= command.id %> Opportunity --recordtype Enterprise

Output as CSV:

<%= config.bin %> <%= command.id %> Account --format csv

# args.sobject.description

API name of the sObject to list.

# flags.target-org.summary

Login username or alias for the target org.

# flags.limit.summary

How many records to show.

# flags.modified.summary

Sort by last modified date instead of created date, and show the modification columns.

# flags.recordtype.summary

Only show records with this record type developer name.

# flags.fields.summary

Extra fields to show, as a comma-separated list. Appended to the default columns.

# flags.format.summary

Output format.

# flags.truncate.summary

Truncate cell values to this many characters. Use 0 to disable.

# info.fetching

Fetching records...

# error.unknownSObject

Unknown sObject: %s

# error.missingSortField

%s has no %s field, so there is nothing to sort by.

# error.noRecordTypes

%s does not use record types.
