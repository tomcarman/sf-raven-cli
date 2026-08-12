# summary

Remove top-level profile sections from this project's sync exclusions.

# description

Removes one or more section tags from the project's persisted exclusion list in sfdx-project.json. Removed sections are synced again from the next "sf raven profile sync" run onwards. Values that are not currently excluded produce a warning and are otherwise ignored.

# args.sections.description

Section tags to stop excluding. Separate multiple values with spaces or commas.

# examples

Stop excluding flow access entries:

<%= config.bin %> <%= command.id %> flowAccesses

# info.removedSections

Removed sections: %s

# info.excludedSections

Excluded sections are now: %s

# info.noExclusions

No sections are excluded.

# warning.notExcluded

%s was not in the exclusion list.

# error.noSections

No section names were provided.
