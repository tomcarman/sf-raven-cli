# summary

Show how many records populate each field on an sObject.

# description

Samples the newest records on the object and reports what percentage of them have a value in each field, dead fields first. Use it to find candidates for deletion before a cleanup.

By default the newest 1000 records are sampled; raise or lower that with --sample-size. When the object has fewer records than the sample size, the numbers are exact.

Compound parent fields (Address, Geolocation) are skipped and their components counted instead. Formula fields are included.

# examples

Show field usage for Account:

<%= config.bin %> <%= command.id %> --sobject Account

Sample more records across several objects:

<%= config.bin %> <%= command.id %> --sobject Account,Contact --sample-size 5000

Get exact org-wide numbers instead of a sample:

<%= config.bin %> <%= command.id %> --sobject Account --deep

Only look at custom fields:

<%= config.bin %> <%= command.id %> --sobject Account --custom-only

Check specific fields and write the result to a file:

<%= config.bin %> <%= command.id %> --sobject Account --field Industry,Rating --csv usage.csv

# flags.target-org.summary

Login username or alias for the target org.

# flags.sobject.summary

API name of the sObject. Accepts a comma-separated list.

# flags.field.summary

Only report on these fields, as a comma-separated list of API names.

# flags.custom-only.summary

Only report on custom (__c) fields.

# flags.sample-size.summary

How many of the newest records to sample.

# flags.deep.summary

Count every record in the org instead of sampling, with one COUNT query per field. Slower, but exact. Fields that cannot be filtered on keep their sampled figure and are marked.

# flags.csv.summary

Write the results to this file as CSV instead of printing a table.

# info.sampling

Sampling records...

# info.counting

Counting records...

# info.csvWritten

Wrote %s rows to %s.

# label.sampledScope

sampled %s of %s records

# label.deepScope

%s records

# error.unknownSObject

Unknown sObject: %s

# error.noFields

No countable fields found on %s.
