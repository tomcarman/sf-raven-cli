# summary

Open a record, object, or Setup page in the browser.

# description

Resolves the thing you name and opens it in your default browser using a single-use frontdoor URL, so you land in the org already logged in.

Resolution runs in tiers. A 15- or 18-character record Id is opened directly: Salesforce redirects to whichever view is right for that object, including tooling objects. Otherwise the name is matched against sObjects (API name, API name ignoring the namespace and __c suffix, then label) and opened in Object Manager. Finally it is matched against the Setup page aliases.

Projects can define their own Setup aliases in sfdx-project.json under plugins.sf-raven.open.aliases, as a map of alias to Setup path (for example { "einstein": "EinsteinGPT/home" }). They are merged over the built-ins, so a project alias wins on conflict.

# examples

Open a record by Id:

<%= config.bin %> <%= command.id %> 0015g00000ABCDEfGH --target-org dev

Open an object in Object Manager, matching without the __c suffix:

<%= config.bin %> <%= command.id %> invoice

Open a Setup page by alias:

<%= config.bin %> <%= command.id %> perm-sets

Print the URL instead of launching a browser:

<%= config.bin %> <%= command.id %> 0015g00000ABCDEfGH --url-only

# args.thing.description

Record Id, sObject name, or Setup page alias to open.

# flags.target-org.summary

Login username or alias for the target org.

# flags.url-only.summary

Print the resolved URL instead of opening a browser. The URL is single-use and short-lived.

# info.opening

Opening %s %s...

# info.resolving

Resolving...

# prompt.selectSObject

Multiple objects match. Which one?

# label.kind.record

record

# label.kind.sobject

object

# label.kind.alias

Setup page

# label.categories

record Ids, sObjects, Setup aliases

# error.notResolvable

Could not work out what "%s" is. Tried: %s.
