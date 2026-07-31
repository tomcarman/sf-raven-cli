import { escapeSoqlString } from './query.js';
import { formatRecordCell } from './recordQuery.js';
import { type TableColumn } from './table.js';

export type FieldDefinitionRecord = {
  EntityDefinition: { QualifiedApiName: string };
  Label: string;
  QualifiedApiName: string;
  DataType: string;
  IsNillable: boolean;
  Description: string | null;
};

/** The field list query shared by `object display fields` and the SOQL REPL's `\fields`. */
export const buildFieldDefinitionQuery = (sobject: string): string =>
  'SELECT EntityDefinition.QualifiedApiName, Label, QualifiedApiName, DataType, IsNillable, Description ' +
  `FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${escapeSoqlString(sobject)}' ` +
  'ORDER BY QualifiedApiName';

const descriptionWidth = 60;

export const fieldDefinitionColumns: Array<TableColumn<FieldDefinitionRecord>> = [
  { header: 'Name', get: (row) => row.Label },
  { header: 'Developer Name', get: (row) => row.QualifiedApiName },
  { header: 'Type', get: (row) => row.DataType },
  { header: 'Required', get: (row) => (row.IsNillable ? '' : '✓') },
  { header: 'Description', get: (row) => formatRecordCell(row.Description, descriptionWidth) },
];
