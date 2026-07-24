# summary

Fetch any record by id with full-field output.

# description

Detect the object from the record id's key prefix, describe the object to build the full field list, query every field, and render the record transposed for the terminal: fields as rows, one column per record. Long values are truncated with an ellipsis; null values render as blank cells.

# examples

Fetch every field of a record by id:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH

Fetch a record as JSON:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --json

# flags.target-org.summary

Login username or alias for the target org.

# flags.record-ids.summary

Comma-delimited list of 15 or 18 character record ids to fetch.

# info.fetching

Fetching record(s)...

# warning.recordsNotFound

No record was found for the following id(s): %s
