# summary

Add top-level profile sections to this project's sync exclusions.

# description

Adds one or more top-level profile section tags (e.g. flowAccesses) to the project's persisted exclusion list, stored in sfdx-project.json and shared with the team via source control. Excluded sections are stripped from every profile written by "sf raven profile sync" and "sf raven profile sync select", so a section already present in a local profile file is removed on the next sync. Section names are accepted as-is - they are matched exactly (case-sensitive) against top-level tags in the Profile XML and are not validated against known metadata, so new Salesforce section types work without a plugin update. Nested tags (e.g. the flow or enabled tags inside flowAccesses) never match.

# args.sections.description

Top-level profile section tags to exclude. Separate multiple values with spaces or commas.

# examples

Exclude flow access entries from synced profiles:

<%= config.bin %> <%= command.id %> flowAccesses

Exclude multiple sections at once:

<%= config.bin %> <%= command.id %> flowAccesses layoutAssignments

# info.addedSections

Added sections: %s

# info.excludedSections

Excluded sections are now: %s

# error.noSections

No section names were provided.
