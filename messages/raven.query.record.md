# summary

Fetch any record by id with full-field output.

# description

Detect the object from the record id's key prefix, describe the object to build the full field list, query every field, and render the record transposed for the terminal: fields as rows, one column per record. If the key prefix is unknown to the regular API, detection falls back to the Tooling API, so setup entities (e.g. ApexClass) work the same way. Long values are truncated with an ellipsis; null values render as blank cells.

# examples

Fetch every field of a record by id:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH

Fetch only selected fields, including a parent relationship path:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --fields Name,Industry,Owner.Name

Fetch every field plus selected parent relationship paths:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --extra-fields Owner.Name,Owner.Profile.Name

Fetch a record showing only populated fields, with untruncated values:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --omit-null --truncate 0

Fetch a record as csv for a spreadsheet:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --format csv

Fetch a record TOON-encoded for an LLM context:

<%= config.bin %> <%= command.id %> --record-ids 001Kf00001aBcDeFGH --format toon

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

# flags.format.summary

Output format: table (transposed, for the terminal), json (raw records array), csv (one row per record), or toon (TOON-encoded records array). Non-table formats never truncate values.

# flags.truncate.summary

Width at which table cell values are truncated with an ellipsis; 0 means unlimited. Table output only.

# flags.omit-null.summary

Omit table rows where every record's value is null. Table output only.

# info.fetching

Fetching record(s)...

# warning.recordsNotFound

No record was found for the following id(s): %s

# error.noRecordIds

No record ids were supplied.

# error.invalidRecordIds

Invalid Salesforce record id(s): %s. Ids must be 15 or 18 alphanumeric characters.

# error.unknownFields

Unknown field(s) for %s: %s.

# error.unknownKeyPrefix

No object with key prefix '%s' was found in either the regular or Tooling API, so the object type could not be determined.
