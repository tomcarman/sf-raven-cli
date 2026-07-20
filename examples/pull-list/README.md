# sf raven pull list - example output

Real output of the three `sf raven pull list` shapes, captured against a live Developer Edition org from a project containing three ApexClasses (one local-only, two also present in the org). The sf-raven TUI copies these as fixtures.

| File | Command |
| --- | --- |
| `list.json` | `sf raven pull list --json` |
| `list-all-types.json` | `sf raven pull list --all-types --target-org <org> --json` |
| `list-metadata-type.json` | `sf raven pull list --metadata-type ApexClass --target-org <org> --json` |
