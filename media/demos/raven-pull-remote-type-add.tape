Output raven-pull-remote-type-add.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 400
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

Type "sf raven pull remote type add --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Screen@180s /ApexPage/
Show
Sleep 2s
Type "^Flow$"
Sleep 1500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 5s
