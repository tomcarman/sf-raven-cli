import chalk from 'chalk';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.automations');

type ApexTriggerRecord = {
  Name: string;
  Status: string;
  UsageBeforeInsert: boolean;
  UsageAfterInsert: boolean;
  UsageBeforeUpdate: boolean;
  UsageAfterUpdate: boolean;
  UsageBeforeDelete: boolean;
  UsageAfterDelete: boolean;
  UsageAfterUndelete: boolean;
};

type FlowRecord = {
  Label: string;
  ApiName: string;
  TriggerType: string;
  RecordTriggerType: string;
  ProcessType: string;
  IsActive: boolean;
  ActiveVersionId: string | null;
  LatestVersionId: string | null;
};

type FlowWithOrder = FlowRecord & { TriggerOrder?: number };

type FlowMetadata = { triggerOrder?: number | null };

type WorkflowRuleRecord = {
  Name: string;
  TriggerType: string;
  Active: boolean;
};

type WorkflowRuleListRecord = { Id: string; Name: string };
type WorkflowRuleMetadata = { active?: boolean; triggerType?: string };

type ToolingConnection = {
  tooling: {
    query: <T>(soql: string) => Promise<{ records: T[] }>;
  };
};

type AutomationRow = {
  phase: string;
  phaseOrder: number;
  type: string;
  name: string;
  events: string;
  active: boolean;
  triggerOrder?: number;
};

export type RavenInspectAutomationsResult = {
  sobject: string;
  automations: AutomationRow[];
};

export default class RavenInspectAutomations extends SfCommand<RavenInspectAutomationsResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
      required: true,
    }),
    sobject: Flags.string({
      summary: messages.getMessage('flags.sobject.summary'),
      char: 's',
      required: true,
    }),
    all: Flags.boolean({
      summary: messages.getMessage('flags.all.summary'),
      char: 'a',
      default: false,
    }),
  };

  public async run(): Promise<RavenInspectAutomationsResult> {
    const { flags } = await this.parse(RavenInspectAutomations);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];
    const conn = org.getConnection();
    const toolingConn = conn as unknown as ToolingConnection;
    const sobject = flags.sobject;
    const showAll = flags.all;

    this.spinner.start(messages.getMessage('info.loading'));

    let triggers: ApexTriggerRecord[] = [];
    let flows: FlowWithOrder[] = [];
    let workflowRules: WorkflowRuleRecord[] = [];

    try {
      const activeOnlyTrigger = showAll ? '' : ' AND Status = \'Active\'';
      const activeOnlyFlow = showAll ? '' : ' AND IsActive = true';

      type EntityResult = { records: Array<{ DurableId: string }> };
      type TriggerResult = { records: ApexTriggerRecord[] };
      type FlowResult = { records: FlowRecord[] };

      // FlowDefinitionView references the triggering object by its EntityDefinition
      // DurableId. For standard objects this equals the API name; for custom objects it
      // is the entity id, so resolve it rather than assuming the API name works.
      const entityResult = (await conn.query(
        `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${sobject}' LIMIT 1`
      )) as unknown as EntityResult;
      const entityId = entityResult.records[0]?.DurableId ?? sobject;

      // Start all three queries before awaiting any so they run in parallel
      const triggerQuery = conn.query(
        `SELECT Name, Status, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger WHERE TableEnumOrId = '${sobject}'${activeOnlyTrigger} ORDER BY Name`
      );

      const flowQuery = conn.query(
        `SELECT Label, ApiName, TriggerType, RecordTriggerType, ProcessType, IsActive, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE TriggerObjectOrEventId = '${entityId}' AND ProcessType IN ('AutoLaunchedFlow', 'Workflow') AND TriggerType IN ('RecordBeforeSave', 'RecordAfterSave')${activeOnlyFlow} ORDER BY Label`
      );

      triggers = ((await triggerQuery) as unknown as TriggerResult).records;
      const rawFlows = ((await flowQuery) as unknown as FlowResult).records;

      // Flow Trigger Order lives in the flow version's metadata, not on FlowDefinitionView,
      // so fetch each record-triggered flow's metadata to read it. Process Builder
      // processes (ProcessType 'Workflow') have no user-settable trigger order.
      flows = await Promise.all(
        rawFlows.map(async (flow): Promise<FlowWithOrder> => {
          const versionId = flow.ActiveVersionId ?? flow.LatestVersionId;

          if (flow.ProcessType !== 'AutoLaunchedFlow' || versionId == null) {
            return { ...flow, TriggerOrder: undefined };
          }

          const metadata = (
            await toolingConn.tooling.query<{ Metadata: FlowMetadata }>(
              `SELECT Metadata FROM Flow WHERE Id = '${versionId}'`
            )
          ).records[0]?.Metadata;

          return { ...flow, TriggerOrder: metadata?.triggerOrder ?? undefined };
        })
      );

      // WorkflowRule exposes triggerType/active only inside its Metadata compound field,
      // which the Tooling API returns only when querying a single record. So list the
      // rules, then fetch each rule's Metadata individually.
      const ruleList = (await toolingConn.tooling.query<WorkflowRuleListRecord>(
        `SELECT Id, Name FROM WorkflowRule WHERE TableEnumOrId = '${sobject}' ORDER BY Name`
      )).records;

      const ruleRecords = await Promise.all(
        ruleList.map(async (rule) => {
          const metadata = (
            await toolingConn.tooling.query<{ Metadata: WorkflowRuleMetadata }>(
              `SELECT Metadata FROM WorkflowRule WHERE Id = '${rule.Id}'`
            )
          ).records[0]?.Metadata;

          return { Name: rule.Name, TriggerType: metadata?.triggerType ?? '', Active: metadata?.active === true };
        })
      );

      workflowRules = showAll ? ruleRecords : ruleRecords.filter((rule) => rule.Active);
    } finally {
      this.spinner.stop();
    }

    const rows: AutomationRow[] = [
      ...triggers.flatMap(triggerToRows),
      ...flows.map(flowToRow),
      ...workflowRules.map(workflowToRow),
    ].sort(
      (a, b) =>
        a.phaseOrder - b.phaseOrder || compareTriggerOrder(a.triggerOrder, b.triggerOrder) || a.name.localeCompare(b.name)
    );

    const activeCount = rows.filter((r) => r.active).length;
    const inactiveCount = rows.filter((r) => !r.active).length;
    const countLabel = showAll ? `${activeCount} active, ${inactiveCount} inactive` : `${activeCount} active`;

    ux.log(`\n${messages.getMessage('info.header', [sobject, countLabel])}\n`);

    if (rows.length === 0) {
      ux.log(messages.getMessage('info.none'));
    } else {
      ux.table(rows, getTableColumns(showAll));
    }

    // Flows without an explicit Trigger Order run in an unpredictable sequence
    const hasUnorderedFlows = flows.some((flow) => flow.ProcessType === 'AutoLaunchedFlow' && flow.TriggerOrder == null);

    if (hasUnorderedFlows) {
      ux.log(`\n${messages.getMessage('info.unorderedFlows')}`);
    }

    return { sobject, automations: rows };
  }
}

const triggerToRows = (trigger: ApexTriggerRecord): AutomationRow[] => {
  const active = trigger.Status === 'Active';
  const rows: AutomationRow[] = [];

  const beforeEvents: string[] = [];
  if (trigger.UsageBeforeInsert) beforeEvents.push('Insert');
  if (trigger.UsageBeforeUpdate) beforeEvents.push('Update');
  if (trigger.UsageBeforeDelete) beforeEvents.push('Delete');

  const afterEvents: string[] = [];
  if (trigger.UsageAfterInsert) afterEvents.push('Insert');
  if (trigger.UsageAfterUpdate) afterEvents.push('Update');
  if (trigger.UsageAfterDelete) afterEvents.push('Delete');
  if (trigger.UsageAfterUndelete) afterEvents.push('Undelete');

  if (beforeEvents.length > 0) {
    rows.push({ phase: 'Before Trigger', phaseOrder: 2, type: 'Apex Trigger', name: trigger.Name, events: beforeEvents.join(', '), active });
  }

  if (afterEvents.length > 0) {
    rows.push({ phase: 'After Trigger', phaseOrder: 3, type: 'Apex Trigger', name: trigger.Name, events: afterEvents.join(', '), active });
  }

  return rows;
};

const flowToRow = (flow: FlowWithOrder): AutomationRow => {
  const isProcessBuilder = flow.ProcessType === 'Workflow';
  const isBeforeSave = flow.TriggerType === 'RecordBeforeSave';

  if (isProcessBuilder) {
    return { phase: 'Post-Save', phaseOrder: 6, type: 'Process Builder', name: flow.Label, events: formatFlowTriggerType(flow.RecordTriggerType), active: flow.IsActive };
  }

  return {
    phase: isBeforeSave ? 'Before Save' : 'After Save',
    phaseOrder: isBeforeSave ? 1 : 4,
    type: 'Flow',
    name: flow.Label,
    events: formatFlowTriggerType(flow.RecordTriggerType),
    active: flow.IsActive,
    triggerOrder: flow.TriggerOrder,
  };
};

// Flows with an explicit Trigger Order run first, in ascending order; those without run
// afterwards in an undefined sequence.
const compareTriggerOrder = (a?: number, b?: number): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
};

const workflowToRow = (rule: WorkflowRuleRecord): AutomationRow => ({
  phase: 'Post-Save',
  phaseOrder: 5,
  type: 'Workflow Rule',
  name: rule.Name,
  events: formatWorkflowTriggerType(rule.TriggerType),
  active: rule.Active,
});

const formatFlowTriggerType = (recordTriggerType: string): string => {
  switch (recordTriggerType) {
    case 'Create': return 'Insert';
    case 'Update': return 'Update';
    case 'CreateAndUpdate': return 'Insert, Update';
    case 'Delete': return 'Delete';
    default: return recordTriggerType ?? '';
  }
};

const formatWorkflowTriggerType = (triggerType: string): string => {
  switch (triggerType) {
    case 'onCreateOnly': return 'Insert';
    case 'onCreateOrTriggeringUpdate': return 'Insert, Update';
    case 'onAllChanges': return 'Insert, Update, Undelete';
    case 'onOpportunityClose': return 'Close';
    default: return triggerType ?? '';
  }
};

const cell = (row: AutomationRow, value: string): string =>
  row.active ? value : chalk.dim(value);

const getTableColumns = (
  showAll: boolean
): {
  [key: string]: {
    header: string;
    get: (row: AutomationRow) => string;
  };
} => ({
  phase: {
    header: 'Phase',
    get: (row) => cell(row, row.phase),
  },
  type: {
    header: 'Type',
    get: (row) => cell(row, row.type),
  },
  name: {
    header: 'Name',
    get: (row) => cell(row, row.name),
  },
  events: {
    header: 'Events',
    get: (row) => cell(row, row.events),
  },
  order: {
    header: 'Order',
    get: (row) => cell(row, row.triggerOrder != null ? row.triggerOrder.toString() : ''),
  },
  ...(showAll
    ? {
        active: {
          header: 'Active',
          get: (row) => (row.active ? '✓' : chalk.dim('✗')),
        },
      }
    : {}),
});
