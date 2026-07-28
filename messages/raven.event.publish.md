# summary

Publish a platform event.

# description

The write-side twin of event subscribe, for testing platform event triggers end to end.

The payload can be a path to a JSON file or an inline JSON string; anything starting with { or [ is treated as inline JSON. A top-level object publishes one event, a top-level array publishes each of its elements in order, one result line each.

The event API name is not validated up front, so an unknown event or an unrecognised field comes back as the API's own error.

# examples

Publish one event from an inline payload:

<%= config.bin %> <%= command.id %> --event Order_Event__e --payload '{"Order_Number__c":"A-1001"}'

Publish a batch from a file:

<%= config.bin %> <%= command.id %> --event Order_Event__e --payload events.json

The subscribe-style channel prefix is accepted too:

<%= config.bin %> <%= command.id %> --event /event/Order_Event__e --payload '{"Order_Number__c":"A-1001"}'

# flags.target-org.summary

Login username or alias for the target org.

# flags.event.summary

API name of the platform event, for example Order_Event__e. A /event/ prefix is accepted and ignored.

# flags.payload.summary

Path to a JSON file, or an inline JSON object or array.

# label.inlinePayload

the inline payload

# info.published

Event %s published to %s: %s

# info.failed

Event %s failed: %s

# error.payloadNotFound

Payload file not found: %s
