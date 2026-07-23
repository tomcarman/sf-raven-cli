# summary

Interactively pick org profiles to sync into local source, including profiles not yet tracked.

# description

Lists every profile in the target org, alongside every profile tracked in local source, in a multi-select fuzzy picker (requires fzf). Each profile is annotated with its status: "both" (tracked locally and in the org), "remote" (org only), or "local" (local source only). Selected profiles that are tracked locally are refreshed in place through the same pipeline as "sf raven profile sync". Selected profiles that exist only in the org are adopted: a new profile file is created in the default package directory's profiles folder, filtered to the components tracked in local source and serialized identically to synced profiles. Selected local-only profiles are skipped with a warning, and cancelling the picker makes no changes.

# examples

Pick profiles from the default org:

<%= config.bin %> <%= command.id %>

Pick profiles from a specific org:

<%= config.bin %> <%= command.id %> --target-org my-org

# flags.target-org.summary

Username or alias of the target org.

# info.listing

Listing profiles from the org and local source

# info.syncing

Syncing profiles %s from the org

# info.noSelection

No profiles selected - nothing to do.

# warning.noProfiles

No profiles found in the org or local source.
