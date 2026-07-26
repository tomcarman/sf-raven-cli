Output raven-apex-log.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 360
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SF_SKIP_NEW_VERSION_CHECK=true OCLIF_DISABLE_LINKED_ESM_WARNING=true"
Enter
Type "cd /home/tom/dev/sf-project-demo/raven-demo"
Enter
Type "( (sleep 15 && sf apex run --file scripts/apex/log-demo.apex -o trailhead) >/dev/null 2>&1 & )"
Enter
Type "clear"
Enter
Show

Type "sf raven apex log --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Screen@120s /Tailing logs/
Show
Sleep 2s
Hide
Wait+Screen@120s /DEBUG/
Show
Sleep 5s
Ctrl+C
Sleep 1500ms
