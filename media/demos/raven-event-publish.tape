Output raven-event-publish.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 260
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SF_SKIP_NEW_VERSION_CHECK=true OCLIF_DISABLE_LINKED_ESM_WARNING=true"
Enter
Type "cd /home/tom/dev/sf-project-demo/raven-demo"
Enter
Type "clear"
Enter
Show

Type `sf raven event publish --target-org trailhead --event Log__e --payload '{"txt_Level__c":"INFO","txl_Message__c":"Order sync started"}'`
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 2s

Type "sf raven event publish --target-org trailhead --event Log__e --payload scripts/data/log-events.json"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 5s
