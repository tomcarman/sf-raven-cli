Output raven-object-display-fieldusage.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1200
Set Height 600
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

Type "sf raven object display fieldusage --target-org trailhead --sobject Account"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
ScrollUp 5
ScrollUp 5
ScrollUp 5
ScrollUp 5
ScrollUp 5
ScrollUp 5
ScrollUp 5
ScrollUp 5
Show
Sleep 6s
