# summary

Sync full Profile metadata from an org into local source files.

# description

Reads the complete content of each Profile directly from the org via the CRUD Metadata API, which is not package-context-scoped, filters it down to the components tracked in local source, and overwrites the tracked profile files in place, wherever they live across package directories. The output is byte-identical to what a full-project `sf project retrieve` would produce for the profiles, in a fraction of the time. With no arguments, every profile tracked in local source is synced; profiles are fetched in parallel batches, and profiles that exist locally but not in the org are skipped with a warning. Entries that reference metadata not present in the local project are filtered out; user permissions, login IP ranges, the custom flag, and the user license are always kept in full. The org read uses the project's sourceApiVersion.

# examples

Sync every locally tracked profile from the default org:

<%= config.bin %> <%= command.id %>

Sync specific profiles:

<%= config.bin %> <%= command.id %> --profile "Admin,Standard User"

Sync a profile from a specific org:

<%= config.bin %> <%= command.id %> --profile Admin --target-org my-org

# flags.target-org.summary

Username or alias of the target org.

# flags.profile.summary

Comma-separated names of the profiles to sync. Defaults to every profile tracked in local source.

# info.syncing

Syncing profiles %s from the org

# info.syncingAll

Syncing all locally tracked profiles from the org

# info.synced

Synced %s -> %s

# warning.skipped

Profile %s is not in the org - skipped.

# warning.failed

Profile %s could not be read from the org: %s

# warning.noProfiles

No locally tracked profiles found to sync.

# error.noProfileNames

The --profile flag was provided without any profile names.
