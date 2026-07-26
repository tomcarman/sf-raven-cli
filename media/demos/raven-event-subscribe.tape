Output raven-event-subscribe.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SF_SKIP_NEW_VERSION_CHECK=true OCLIF_DISABLE_LINKED_ESM_WARNING=true"
Enter
Type "cd /home/tom/dev/sf-project-demo/raven-demo"
Enter
Type "( (sleep 15 && sf apex run --file scripts/apex/publish-events.apex -o trailhead) >/dev/null 2>&1 & )"
Enter
Type "clear"
Enter
Show

Type "sf raven event subscribe --target-org trailhead --event /event/Log__e"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Screen@120s /Listening for events/
Show
Sleep 2s
Hide
Wait+Screen@120s /replayId/
Show
Sleep 6s
