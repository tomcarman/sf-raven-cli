Output raven-soql.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 800
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

Type "sf raven soql --target-org trailhead"
Sleep 500ms
Enter
Hide
Wait+Screen@120s /soql>/
Show
Sleep 1500ms

# Query with tab completion and live syntax highlighting.
Type "SELECT Id, Name, Industry FROM Acco"
Sleep 800ms
Tab
Sleep 2500ms
Enter
Sleep 800ms
Type ` WHERE Industry = 'Energy' LIMIT 5`
Sleep 1500ms
Enter
Hide
Wait+Screen@120s /rows/
Show
Sleep 3s

# Drill into a row: every field of the record, paged.
Type `\record 1`
Sleep 500ms
Enter
Hide
Wait+Screen@120s /IsDeleted/
Show
Sleep 2500ms
Down@250ms 4
Sleep 1500ms
Type "q"
Sleep 1500ms

# The meta-command list.
Type `\help`
Sleep 500ms
Enter
Sleep 3500ms

# Reverse history search recalls the earlier query.
Ctrl+R
Sleep 800ms
Type "energy"
Sleep 1500ms
Enter
Sleep 1s
Enter
Sleep 3s

Type `\q`
Sleep 300ms
Enter
Sleep 1500ms
