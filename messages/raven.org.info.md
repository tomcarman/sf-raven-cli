# summary

Show a summary card for an org.

# description

The things you would otherwise click through Setup for, in one place: who the org is, what it is using of its storage and API limits, how many users it has and under which licenses, and which release it is on.

The release and maintenance section comes from the Salesforce Trust API, the one call that leaves your org. If it cannot be reached the section reports as unavailable and the rest of the card still prints.

# examples

Show the summary for the default org:

<%= config.bin %> <%= command.id %>

Show the summary for a specific org:

<%= config.bin %> <%= command.id %> --target-org dev

# flags.target-org.summary

Login username or alias for the target org.

# info.loading

Loading org details...

# info.trustUnavailable

Release information is unavailable (the Trust API could not be reached).

# info.noMaintenance

None scheduled.

# label.identity

Identity

# label.name

Name

# label.orgId

Org Id

# label.edition

Edition

# label.instance

Instance

# label.myDomain

My Domain

# label.sandbox

Sandbox

# label.created

Created

# label.refreshed

Created/refreshed

# label.apiVersion

Max API version

# label.limits

Storage & limits

# label.users

Users

# label.activeUsers

Active users

# label.release

Release & maintenance

# label.releaseVersion

Release

# label.releaseNumber

Release number

# label.maintenance

Upcoming windows

# error.noOrganization

Could not read the Organization record for this org.
