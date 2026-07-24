# summary

Fetch any record by id with full-field output.

# description

Detect the object from the record id's key prefix, describe the object to build the full field list, query every field, and render the record transposed for the terminal: fields as rows, one column per record. Long values are truncated with an ellipsis; null values render as blank cells.

# examples

Fetch every field of a record by id:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH

Fetch only selected fields, including a parent relationship path:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --fields Name,Industry,Owner.Name

Fetch every field plus selected parent relationship paths:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --extra-fields Owner.Name,Owner.Profile.Name

Fetch a record as JSON:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --json

# flags.target-org.summary

Login username or alias for the target org.

# flags.record-ids.summary

Comma-delimited list of 15 or 18 character record ids to fetch.

# flags.fields.summary

Comma-delimited list of fields to retrieve instead of the full field list; dot-notation relationship paths (e.g. Owner.Name) are allowed.

# flags.extra-fields.summary

Comma-delimited list of fields (typically relationship paths) to add on top of the full field list.

# info.fetching

Fetching record(s)...

# warning.recordsNotFound

No record was found for the following id(s): %s
