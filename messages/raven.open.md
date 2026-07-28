# summary

Open a record, object, or Setup page in the browser.

# description

Resolves the thing you name and opens it in your default browser using a single-use frontdoor URL, so you land in the org already logged in.

A 15- or 18-character record Id is opened directly: Salesforce redirects to whichever view is right for that object, including tooling objects.

# examples

Open a record by Id:

<%= config.bin %> <%= command.id %> 0015g00000ABCDEfGH --target-org dev

Print the URL instead of launching a browser:

<%= config.bin %> <%= command.id %> 0015g00000ABCDEfGH --url-only

# args.thing.description

Record Id to open.

# flags.target-org.summary

Login username or alias for the target org.

# flags.url-only.summary

Print the resolved URL instead of opening a browser. The URL is single-use and short-lived.

# info.opening

Opening %s %s...

# label.kind.record

record

# label.categories

record Ids

# error.notResolvable

Could not work out what "%s" is. Tried: %s.
