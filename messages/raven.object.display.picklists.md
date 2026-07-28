# summary

Show picklist values for the fields on an sObject.

# description

Lists the active values of every picklist field on the object, with the label and API name of each value. The global default value is marked with an asterisk, and dependent picklists note the field that controls them.

On objects that use record types, values are shown as a matrix: one column per record type, including Master, with a check mark where the value is available and a star where it is that record type's default. Record types you cannot access are shown as unavailable rather than failing the command. Objects without record types get the flat list.

Multi-select picklists are included.

# examples

Show every picklist on Account:

<%= config.bin %> <%= command.id %> --sobject Account

Show picklists across several objects:

<%= config.bin %> <%= command.id %> --sobject Account,Contact

Narrow to specific fields:

<%= config.bin %> <%= command.id %> --sobject Account --field Industry,Rating

Write the values to a file:

<%= config.bin %> <%= command.id %> --sobject Account --csv picklists.csv

# flags.target-org.summary

Login username or alias for the target org.

# flags.sobject.summary

API name of the sObject. Accepts a comma-separated list.

# flags.field.summary

Only show these picklist fields, as a comma-separated list of API names.

# flags.csv.summary

Write the values to this file as CSV instead of printing them.

# info.loading

Loading picklists...

# info.csvWritten

Wrote %s rows to %s.

# info.noPicklists

No picklist fields.

# info.noValues

No active values.

# label.multiSelect

multi-select

# label.controlledBy

Controlled by: %s

# label.unavailable

(unavailable)

# error.unknownSObject

Unknown sObject: %s
