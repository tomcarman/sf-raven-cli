Output raven-deploy-cancel.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 460
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SF_SKIP_NEW_VERSION_CHECK=true OCLIF_DISABLE_LINKED_ESM_WARNING=true"
Enter
Type "cd /home/tom/dev/sf-project-demo/raven-demo"
Enter
Type "sf project deploy start --async --test-level RunSpecifiedTests --tests SlowDemoTest -o trailhead >/dev/null 2>&1"
Enter
Wait+Line@180s /^\$/
Type "clear"
Enter
Show

Type "sf raven deploy cancel --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Screen@120s /0Af/
Show
Sleep 2s
Down
Sleep 1s
Enter
Sleep 1500ms
Type "y"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 5s
