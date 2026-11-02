import chalk from 'chalk';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import {
  buildAutomationRows,
  type ApexTriggerRecord,
  type AutomationRow,
  type FlowRecord,
  type FlowWithOrder,
  type WorkflowRuleRecord,
} from '../../../shared/inspectAutomations.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.inspect.automations');

type FlowMetadata = { triggerOrder?: number | null };

type WorkflowRuleListRecord = { Id: string; Name: string };
type WorkflowRuleMetadata = { active?: boolean; triggerType?: string };

type ToolingConnection = {
  tooling: {
    query: <T>(soql: string) => Promise<{ records: T[] }>;
  };
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
      const activeOnlyTrigger = showAll ? '' : " AND Status = 'Active'";
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
      const ruleList = (
        await toolingConn.tooling.query<WorkflowRuleListRecord>(
          `SELECT Id, Name FROM WorkflowRule WHERE TableEnumOrId = '${sobject}' ORDER BY Name`
        )
      ).records;

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

    const rows = buildAutomationRows({ triggers, flows, workflowRules });

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
    const hasUnorderedFlows = flows.some(
      (flow) => flow.ProcessType === 'AutoLaunchedFlow' && flow.TriggerOrder == null
    );

    if (hasUnorderedFlows) {
      ux.log(`\n${messages.getMessage('info.unorderedFlows')}`);
    }

    return { sobject, automations: rows };
  }
}

const cell = (row: AutomationRow, value: string): string => (row.active ? value : chalk.dim(value));

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
