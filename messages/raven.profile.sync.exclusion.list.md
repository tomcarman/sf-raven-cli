# summary

List this project's profile sync exclusions.

# description

Prints the top-level profile section tags persisted in sfdx-project.json that "sf raven profile sync" and "sf raven profile sync select" strip from every synced profile. Runtime-only exclusions passed via --exclude are not part of the persisted list.

# examples

List the excluded sections:

<%= config.bin %> <%= command.id %>

# info.noExclusions

No sections are excluded.
