# summary

Subscribe to Platform Events.

# description

Platform Events are printed to the terminal. An optional flag can be used to replay events from a given replay id. Default timeout is 3 minutes, but can be extended to 30 minutes.

# flags.target-org.summary

Login username or alias for the target org.

# flags.event.summary

The name of the Platform Event that you want to subscribe with '/event/' prefix eg. /event/My_Event\_\_e.

# flags.replayid.summary

The replay id to replay events from eg. 21980378.

# flags.timeout.summary

How long to subscribe for before timing out in minutes eg. 10. Default is 3 minutes.

# examples

- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event\_\_e
- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event\_\_e --replayid 21980378
- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event\_\_e --timeout 10
- <%= config.bin %> <%= command.id %> --target-org dev --event /event/My_Event\_\_e --replayid 21980378 --timeout 10
