# summary

Subscribe to Platform Events and Change Data Capture events.

# description

Events are printed to the terminal. An optional flag can be used to replay events from a given replay id. Default timeout is 3 minutes, but can be extended to 30 minutes.

--event takes a Platform Event name (My_Event__e or /event/My_Event__e) or a change event name (AccountChangeEvent or /data/AccountChangeEvent). A name ending in ChangeEvent is subscribed on /data/; any other bare name on /event/. A name starting with / is used as the channel as is.

With --ndjson, each message is written to stdout as one JSON object per line, and nothing else is: {"type": "event", "channel", "replayId", "receivedAt", "payload"} for each event, {"type": "status", "event": "connected" | "timeout"}, and {"type": "error", "message"}. In this mode there is no timeout unless --timeout is given, and the 30 minute maximum does not apply.

# flags.target-org.summary

Login username or alias for the target org.

# flags.event.summary

The event to subscribe to, eg. My_Event__e, /event/My_Event__e, AccountChangeEvent or /data/AccountChangeEvent.

# flags.replayid.summary

The replay id to replay events from eg. 21980378. Use -1 for new events only, or -2 for all retained events.

# flags.timeout.summary

How long to subscribe for before timing out in minutes eg. 10. Default is 3 minutes, maximum 30 (minimum 3). With --ndjson there is no timeout unless one is given, and no maximum.

# flags.ndjson.summary

Stream machine-readable NDJSON events, one JSON object per line, with no spinner or other output on stdout. Cannot be combined with --json.

# info.exiting

Exiting.

# error.ndjsonWithJson

--ndjson cannot be combined with --json.

# error.timeoutTooLong

--timeout cannot be more than 30 minutes. Use --ndjson for longer subscriptions.

# examples

- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event__e
- <%= config.bin %> <%= command.id %> --target-org dev --event My_Event__e --replayid 21980378
- <%= config.bin %> <%= command.id %> --target-org dev --event AccountChangeEvent --timeout 10
- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event__e --replayid -2 --timeout 10
- <%= config.bin %> <%= command.id %> --target-org dev --event AccountChangeEvent --ndjson
