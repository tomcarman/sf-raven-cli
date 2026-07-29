Output raven-open.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 280
Set Padding 24
Set Framerate 30
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PS1='$ ' SF_SKIP_NEW_VERSION_CHECK=true OCLIF_DISABLE_LINKED_ESM_WARNING=true"
Enter
# A browser cannot be shown in a terminal recording, so stub out the launcher
# and let the recording show the resolution, which is the part worth seeing.
Type "mkdir -p /tmp/raven-demo-bin"
Enter
Type "echo '#!/bin/sh' > /tmp/raven-demo-bin/xdg-open"
Enter
Type "echo 'exit 0' >> /tmp/raven-demo-bin/xdg-open"
Enter
Type "chmod +x /tmp/raven-demo-bin/xdg-open"
Enter
Type "export PATH=/tmp/raven-demo-bin:$PATH"
Enter
Type "cd /home/tom/dev/sf-project-demo/raven-demo"
Enter
Type "clear"
Enter
Show

Type "sf raven open 001U0000002KmDvIAK --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 2s

Type "sf raven open perm-sets --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 2s

Type "sf raven open bird --target-org trailhead"
Sleep 500ms
Enter
Sleep 1s
Hide
Wait+Screen@120s /Bird__c/
Show
Sleep 2s
Down
Sleep 500ms
Down
Sleep 1s
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 5s
