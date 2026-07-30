# summary

Show what a metadata component depends on and what depends on it.

# description

Queries the MetadataComponentDependency API to show outbound dependencies (what this component uses) and inbound references (what uses this component).

Supported types: ApexClass, ApexTrigger, Flow, CustomObject, CustomField, LightningComponentBundle, AuraDefinitionBundle.

For CustomField, provide the name as ObjectApiName.FieldApiName (e.g. Account.MyField__c).

# flags.target-org.summary

Login username or alias for the target org.

# flags.type.summary

The metadata type of the component.

# flags.name.summary

The API name of the component. For CustomField use ObjectName.FieldName format.

# info.resolving

Resolving dependencies...

# info.header

Dependencies for %s: %s

# info.dependsOn

Depends on (%s)

# info.referencedBy

Referenced by (%s)

# info.none

  None.

# examples

- <%= config.bin %> <%= command.id %> --target-org dev --type ApexClass --name AccountService

- <%= config.bin %> <%= command.id %> --target-org dev --type Flow --name Sync_Account_to_ERP

- <%= config.bin %> <%= command.id %> --target-org dev --type CustomObject --name Account

- <%= config.bin %> <%= command.id %> --target-org dev --type CustomField --name Account.MyField__c
