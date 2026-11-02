import assert from 'node:assert/strict';
import {
  buildAutomationRows,
  type ApexTriggerRecord,
  type FlowWithOrder,
  type WorkflowRuleRecord,
} from '../../src/shared/inspectAutomations.js';

const trigger = (overrides: Partial<ApexTriggerRecord> = {}): ApexTriggerRecord => ({
  Name: 'AccountTrigger',
  Status: 'Active',
  UsageBeforeInsert: false,
  UsageAfterInsert: false,
  UsageBeforeUpdate: false,
  UsageAfterUpdate: false,
  UsageBeforeDelete: false,
  UsageAfterDelete: false,
  UsageAfterUndelete: false,
  ...overrides,
});

const flow = (overrides: Partial<FlowWithOrder> = {}): FlowWithOrder => ({
  Label: 'Account Before Save',
  ApiName: 'Account_Before_Save',
  TriggerType: 'RecordBeforeSave',
  RecordTriggerType: 'CreateAndUpdate',
  ProcessType: 'AutoLaunchedFlow',
  IsActive: true,
  ActiveVersionId: '301000000000001AAA',
  LatestVersionId: '301000000000001AAA',
  ...overrides,
});

const rule = (overrides: Partial<WorkflowRuleRecord> = {}): WorkflowRuleRecord => ({
  Name: 'Account Rule',
  TriggerType: 'onCreateOnly',
  Active: true,
  ...overrides,
});

describe('inspect automations', () => {
  describe('buildAutomationRows', () => {
    it('splits a trigger into before and after rows with its events', () => {
      const rows = buildAutomationRows({
        triggers: [
          trigger({
            UsageBeforeInsert: true,
            UsageBeforeUpdate: true,
            UsageAfterInsert: true,
            UsageAfterUndelete: true,
          }),
        ],
        flows: [],
        workflowRules: [],
      });

      assert.deepEqual(rows, [
        {
          phase: 'Before Trigger',
          phaseOrder: 2,
          type: 'Apex Trigger',
          name: 'AccountTrigger',
          events: 'Insert, Update',
          active: true,
        },
        {
          phase: 'After Trigger',
          phaseOrder: 3,
          type: 'Apex Trigger',
          name: 'AccountTrigger',
          events: 'Insert, Undelete',
          active: true,
        },
      ]);
    });

    it('marks an inactive trigger and omits a phase with no events', () => {
      const rows = buildAutomationRows({
        triggers: [trigger({ Status: 'Inactive', UsageAfterDelete: true })],
        flows: [],
        workflowRules: [],
      });

      assert.deepEqual(
        rows.map((row) => [row.phase, row.events, row.active]),
        [['After Trigger', 'Delete', false]]
      );
    });

    it('builds flow rows by save phase with the label as name and the trigger order', () => {
      const rows = buildAutomationRows({
        triggers: [],
        flows: [
          flow({ TriggerOrder: 10 }),
          flow({
            Label: 'Account After Save',
            ApiName: 'Account_After_Save',
            TriggerType: 'RecordAfterSave',
            RecordTriggerType: 'Delete',
            IsActive: false,
          }),
        ],
        workflowRules: [],
      });

      assert.deepEqual(
        rows.map(({ phase, phaseOrder, type, name, events, active, triggerOrder }) => ({
          phase,
          phaseOrder,
          type,
          name,
          events,
          active,
          triggerOrder,
        })),
        [
          {
            phase: 'Before Save',
            phaseOrder: 1,
            type: 'Flow',
            name: 'Account Before Save',
            events: 'Insert, Update',
            active: true,
            triggerOrder: 10,
          },
          {
            phase: 'After Save',
            phaseOrder: 4,
            type: 'Flow',
            name: 'Account After Save',
            events: 'Delete',
            active: false,
            triggerOrder: undefined,
          },
        ]
      );
    });

    it('builds a Process Builder row as post-save with no trigger order', () => {
      const [row] = buildAutomationRows({
        triggers: [],
        flows: [
          flow({
            Label: 'Account Process',
            ApiName: 'Account_Process',
            ProcessType: 'Workflow',
            TriggerType: 'RecordAfterSave',
            RecordTriggerType: 'Create',
            TriggerOrder: 5,
          }),
        ],
        workflowRules: [],
      });

      assert.equal(row.phase, 'Post-Save');
      assert.equal(row.phaseOrder, 6);
      assert.equal(row.type, 'Process Builder');
      assert.equal(row.name, 'Account Process');
      assert.equal(row.events, 'Insert');
      assert.equal(row.triggerOrder, undefined);
    });

    it('words workflow rule trigger types as events', () => {
      const rows = buildAutomationRows({
        triggers: [],
        flows: [],
        workflowRules: [
          rule({ Name: 'A', TriggerType: 'onCreateOnly' }),
          rule({ Name: 'B', TriggerType: 'onCreateOrTriggeringUpdate' }),
          rule({ Name: 'C', TriggerType: 'onAllChanges' }),
          rule({ Name: 'D', TriggerType: 'onOpportunityClose' }),
          rule({ Name: 'E', TriggerType: 'somethingNew', Active: false }),
        ],
      });

      assert.deepEqual(
        rows.map((row) => [row.phase, row.phaseOrder, row.type, row.name, row.events, row.active]),
        [
          ['Post-Save', 5, 'Workflow Rule', 'A', 'Insert', true],
          ['Post-Save', 5, 'Workflow Rule', 'B', 'Insert, Update', true],
          ['Post-Save', 5, 'Workflow Rule', 'C', 'Insert, Update, Undelete', true],
          ['Post-Save', 5, 'Workflow Rule', 'D', 'Close', true],
          ['Post-Save', 5, 'Workflow Rule', 'E', 'somethingNew', false],
        ]
      );
    });

    it('carries the API name on flow and Process Builder rows only', () => {
      const rows = buildAutomationRows({
        triggers: [trigger({ UsageBeforeInsert: true, UsageAfterInsert: true })],
        flows: [
          flow({ Label: 'Account Before Save', ApiName: 'Account_Before_Save' }),
          flow({
            Label: 'Account Process',
            ApiName: 'Account_Process',
            ProcessType: 'Workflow',
            TriggerType: 'RecordAfterSave',
          }),
        ],
        workflowRules: [rule()],
      });

      assert.deepEqual(
        rows.map((row) => [row.type, row.name, row.apiName]),
        [
          ['Flow', 'Account Before Save', 'Account_Before_Save'],
          ['Apex Trigger', 'AccountTrigger', undefined],
          ['Apex Trigger', 'AccountTrigger', undefined],
          ['Workflow Rule', 'Account Rule', undefined],
          ['Process Builder', 'Account Process', 'Account_Process'],
        ]
      );
      for (const row of rows.filter((r) => r.type === 'Apex Trigger' || r.type === 'Workflow Rule')) {
        assert.equal('apiName' in row, false, row.type);
      }
    });

    it('sorts by phase, then trigger order with unordered last, then name', () => {
      const rows = buildAutomationRows({
        triggers: [trigger({ Name: 'ZTrigger', UsageBeforeInsert: true, UsageAfterInsert: true })],
        flows: [
          flow({ Label: 'Unordered B', TriggerOrder: undefined }),
          flow({ Label: 'Unordered A', TriggerOrder: undefined }),
          flow({ Label: 'Second', TriggerOrder: 20 }),
          flow({ Label: 'First', TriggerOrder: 10 }),
          flow({ Label: 'After', TriggerType: 'RecordAfterSave' }),
          flow({ Label: 'Process', ProcessType: 'Workflow', TriggerType: 'RecordAfterSave' }),
        ],
        workflowRules: [rule({ Name: 'Rule' })],
      });

      assert.deepEqual(
        rows.map((row) => `${row.phase}: ${row.name}`),
        [
          'Before Save: First',
          'Before Save: Second',
          'Before Save: Unordered A',
          'Before Save: Unordered B',
          'Before Trigger: ZTrigger',
          'After Trigger: ZTrigger',
          'After Save: After',
          'Post-Save: Rule',
          'Post-Save: Process',
        ]
      );
    });
  });
});
