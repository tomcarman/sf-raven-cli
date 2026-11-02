export type ApexTriggerRecord = {
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

export type FlowRecord = {
  Label: string;
  ApiName: string;
  TriggerType: string;
  RecordTriggerType: string;
  ProcessType: string;
  IsActive: boolean;
  ActiveVersionId: string | null;
  LatestVersionId: string | null;
};

export type FlowWithOrder = FlowRecord & { TriggerOrder?: number };

export type WorkflowRuleRecord = {
  Name: string;
  TriggerType: string;
  Active: boolean;
};

export type AutomationRow = {
  phase: string;
  phaseOrder: number;
  type: string;
  // The label for flows and processes, the API name for triggers and workflow rules.
  name: string;
  // Flow and Process Builder rows only: FlowDefinitionView.ApiName, since name holds the label.
  apiName?: string;
  events: string;
  active: boolean;
  triggerOrder?: number;
};

export type AutomationSources = {
  triggers: ApexTriggerRecord[];
  flows: FlowWithOrder[];
  workflowRules: WorkflowRuleRecord[];
};

// Rows in the order Salesforce runs them: by phase, then flow Trigger Order, then name.
export const buildAutomationRows = ({ triggers, flows, workflowRules }: AutomationSources): AutomationRow[] =>
  [...triggers.flatMap(triggerToRows), ...flows.map(flowToRow), ...workflowRules.map(workflowToRow)].sort(
    (a, b) =>
      a.phaseOrder - b.phaseOrder || compareTriggerOrder(a.triggerOrder, b.triggerOrder) || a.name.localeCompare(b.name)
  );

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
    rows.push({
      phase: 'Before Trigger',
      phaseOrder: 2,
      type: 'Apex Trigger',
      name: trigger.Name,
      events: beforeEvents.join(', '),
      active,
    });
  }

  if (afterEvents.length > 0) {
    rows.push({
      phase: 'After Trigger',
      phaseOrder: 3,
      type: 'Apex Trigger',
      name: trigger.Name,
      events: afterEvents.join(', '),
      active,
    });
  }

  return rows;
};

const flowToRow = (flow: FlowWithOrder): AutomationRow => {
  const isProcessBuilder = flow.ProcessType === 'Workflow';
  const isBeforeSave = flow.TriggerType === 'RecordBeforeSave';

  if (isProcessBuilder) {
    return {
      phase: 'Post-Save',
      phaseOrder: 6,
      type: 'Process Builder',
      name: flow.Label,
      apiName: flow.ApiName,
      events: formatFlowTriggerType(flow.RecordTriggerType),
      active: flow.IsActive,
    };
  }

  return {
    phase: isBeforeSave ? 'Before Save' : 'After Save',
    phaseOrder: isBeforeSave ? 1 : 4,
    type: 'Flow',
    name: flow.Label,
    apiName: flow.ApiName,
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
    case 'Create':
      return 'Insert';
    case 'Update':
      return 'Update';
    case 'CreateAndUpdate':
      return 'Insert, Update';
    case 'Delete':
      return 'Delete';
    default:
      return recordTriggerType ?? '';
  }
};

const formatWorkflowTriggerType = (triggerType: string): string => {
  switch (triggerType) {
    case 'onCreateOnly':
      return 'Insert';
    case 'onCreateOrTriggeringUpdate':
      return 'Insert, Update';
    case 'onAllChanges':
      return 'Insert, Update, Undelete';
    case 'onOpportunityClose':
      return 'Close';
    default:
      return triggerType ?? '';
  }
};
