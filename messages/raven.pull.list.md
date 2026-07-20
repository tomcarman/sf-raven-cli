# summary

List metadata types and components available to pull.

# description

Report the metadata inventory used by the interactive pull commands, without any prompts. By default, lists the effective metadata types (the configured `pullRemote.metadataTypes` plugin config, or the types present in the local project when no config exists) with a count of local components per type. Use `--all-types` to list every metadata type the org supports, or `--metadata-type` to list the merged local/remote component list for a single type. Designed for machine consumption via `--json`.

# examples

List the effective metadata types with local counts:

<%= config.bin %> <%= command.id %> --json

List every metadata type the org supports:

<%= config.bin %> <%= command.id %> --all-types --json

List the merged local/remote components for a type:

<%= config.bin %> <%= command.id %> --metadata-type ApexClass --json

# flags.target-org.summary

Username or alias of the target org.

# flags.all-types.summary

List every metadata type the org supports, instead of the effective type list.

# flags.metadata-type.summary

List the merged local/remote components for this metadata type.

# table.name.header

Name

# table.localCount.header

Local Count

# table.status.header

Status

# info.source

Source: %s

# info.noTypes

No metadata types were found.

# info.noComponents

No components were found for %s.
