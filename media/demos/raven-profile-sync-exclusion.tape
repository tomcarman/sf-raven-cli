Output raven-profile-sync-exclusion.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 600
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "cd /private/tmp/claude-501/-Users-tomcarman-dev-sf-raven-cli/94cd84b2-baa9-4444-90ad-fb3b9524d0c6/scratchpad/demo-project"
Enter
Type "alias sf='/Users/tomcarman/dev/sf-raven-cli/bin/run.js'"
Enter
Type "export PS1='$ '"
Enter
Type "clear"
Enter
Show

Type "sf raven profile sync exclusion add flowAccesses,layoutAssignments"
Sleep 500ms
Enter
Sleep 4s

Type "sf raven profile sync exclusion list"
Sleep 500ms
Enter
Sleep 3s

Type "sf raven profile sync --target-org trailhead --dry-run"
Sleep 500ms
Enter
Sleep 10s

Type "sf raven profile sync --target-org trailhead --dry-run --exclude userPermissions"
Sleep 500ms
Enter
Sleep 10s
