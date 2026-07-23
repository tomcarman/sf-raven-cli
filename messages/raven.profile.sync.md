# summary

Sync full Profile metadata from an org into local source files.

# description

Reads the complete content of a Profile directly from the org via the CRUD Metadata API, which is not package-context-scoped, filters it down to the components tracked in local source, and overwrites the tracked profile file in place. The output is byte-identical to what a full-project `sf project retrieve` would produce for the profile, in a fraction of the time. Entries that reference metadata not present in the local project are filtered out; user permissions, login IP ranges, the custom flag, and the user license are always kept in full. The org read uses the project's sourceApiVersion.

# examples

Sync the Admin profile from the default org:

<%= config.bin %> <%= command.id %> --profile Admin

Sync a profile from a specific org:

<%= config.bin %> <%= command.id %> --profile "Standard User" --target-org my-org

# flags.target-org.summary

Username or alias of the target org.

# flags.profile.summary

Name of the profile to sync.

# info.syncing

Syncing profile %s from the org

# info.synced

Synced %s -> %s
