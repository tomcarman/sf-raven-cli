Output raven-profile-sync-select.gif

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
Type "sed -i '/<userLicense>/d' force-app/main/default/profiles/Admin.profile-meta.xml"
Enter
Type "clear"
Enter
Show

Type "sf raven profile sync select --target-org trailhead"
Sleep 500ms
Enter
Sleep 2s
Hide
Wait+Screen@120s /Basic User/
Show
Sleep 2s
Type "Admin"
Sleep 1500ms
Enter
Sleep 2s
Hide
Wait+Line@180s /^\$/
Show
Sleep 5s
