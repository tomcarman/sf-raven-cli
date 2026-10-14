import type { ApexDiagnostic, ExecuteAnonymousResponse } from '@salesforce/apex-node';

/**
 * How much an anonymous Apex run logs. `debug` is apex-node's `DEBUGONLY` header; `fine` and
 * `finest` send per-category levels so the log also carries SOQL, DML and method lines.
 */
export const APEX_LOG_DETAILS = ['debug', 'fine', 'finest'] as const;

export type ApexLogDetail = (typeof APEX_LOG_DETAILS)[number];

export const DEFAULT_APEX_LOG_DETAIL: ApexLogDetail = 'debug';

export const isApexLogDetail = (value: unknown): value is ApexLogDetail =>
  typeof value === 'string' && (APEX_LOG_DETAILS as readonly string[]).includes(value);

/** A `LogInfo` entry of the Apex SOAP API's `DebuggingHeader`, spelt as the WSDL enums are. */
export type ApexLogCategory = { category: string; level: string };

const categories = (levels: Array<[category: string, level: string]>): ApexLogCategory[] =>
  levels.map(([category, level]) => ({ category, level }));

/** The categories sent for the levels that bypass apex-node. */
export const APEX_LOG_CATEGORIES: Record<Exclude<ApexLogDetail, 'debug'>, ApexLogCategory[]> = {
  fine: categories([
    ['Apex_code', 'Fine'],
    ['Apex_profiling', 'Info'],
    ['Db', 'Info'],
    ['System', 'Debug'],
    ['Callout', 'Info'],
    ['Validation', 'Info'],
    ['Workflow', 'Info'],
  ]),
  finest: categories([
    ['Apex_code', 'Finest'],
    ['Apex_profiling', 'Finest'],
    ['Db', 'Finest'],
    ['System', 'Finest'],
    ['Callout', 'Info'],
    ['Validation', 'Info'],
    ['Workflow', 'Info'],
  ]),
};

const xmlCharMap: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};

export const escapeXml = (data: string): string => data.replace(/[<>&'"]/g, (char) => xmlCharMap[char]);

const SOAP_ACTION = 'executeAnonymous';

/**
 * The `executeAnonymous` SOAP envelope apex-node sends, with a `DebuggingHeader` of categories
 * instead of `<debugLevel>DEBUGONLY</debugLevel>`.
 */
export const buildExecuteAnonymousEnvelope = (
  accessToken: string,
  apexCode: string,
  logCategories: ApexLogCategory[]
): string => {
  const debugCategories = logCategories
    .map(
      ({ category, level }) =>
        `<apex:categories><apex:category>${category}</apex:category><apex:level>${level}</apex:level></apex:categories>`
    )
    .join('');

  return `<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
xmlns:cmd="http://soap.sforce.com/2006/08/apex"
xmlns:apex="http://soap.sforce.com/2006/08/apex">
    <env:Header>
        <cmd:SessionHeader>
            <cmd:sessionId>${escapeXml(accessToken)}</cmd:sessionId>
        </cmd:SessionHeader>
        <apex:DebuggingHeader>${debugCategories}</apex:DebuggingHeader>
    </env:Header>
    <env:Body>
        <${SOAP_ACTION} xmlns="http://soap.sforce.com/2006/08/apex">
            <apexcode>${escapeXml(apexCode)}</apexcode>
        </${SOAP_ACTION}>
    </env:Body>
</env:Envelope>`;
};

/** xml2js (via jsforce) gives text for a filled element and an object for `xsi:nil` ones. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const position = (value: unknown): number | undefined => {
  const parsed = Number.parseInt(text(value), 10);
  return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
};

type SoapNode = Record<string, unknown> | undefined;

const child = (node: unknown, key: string): SoapNode =>
  typeof node === 'object' && node != null ? ((node as Record<string, unknown>)[key] as SoapNode) : undefined;

/**
 * Reads a parsed `executeAnonymous` SOAP response into apex-node's response shape, the way
 * apex-node's `ExecuteService.jsonFormat` does, so both paths feed `buildApexRunResult` alike.
 */
export const parseExecuteAnonymousResponse = (soapResponse: unknown): ExecuteAnonymousResponse => {
  const envelope = child(soapResponse, 'soapenv:Envelope');
  const result = child(child(child(envelope, 'soapenv:Body'), 'executeAnonymousResponse'), 'result');

  if (result == null) {
    throw new Error('The org sent an executeAnonymous response without a result.');
  }

  const response: ExecuteAnonymousResponse = {
    compiled: result.compiled === 'true',
    success: result.success === 'true',
  };

  const log = child(child(envelope, 'soapenv:Header'), 'DebuggingInfo')?.debugLog;

  if (typeof log === 'string') {
    response.logs = log;
  }

  if (!response.success) {
    const diagnostic: ApexDiagnostic = {
      compileProblem: text(result.compileProblem),
      exceptionMessage: text(result.exceptionMessage),
      exceptionStackTrace: text(result.exceptionStackTrace),
    };
    const lineNumber = position(result.line);
    const columnNumber = position(result.column);

    if (lineNumber != null) diagnostic.lineNumber = lineNumber;
    if (columnNumber != null) diagnostic.columnNumber = columnNumber;

    response.diagnostic = [diagnostic];
  }

  return response;
};

/** The parts of a `@salesforce/core` Connection the SOAP call needs. */
export type ApexSoapConnection = {
  accessToken?: string | null;
  instanceUrl: string;
  version: string;
  baseUrl(): string;
  request<T>(request: {
    method: 'GET' | 'POST';
    url: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<T>;
};

const redact = (message: string, secrets: Array<string | null | undefined>): string =>
  secrets.reduce<string>((text_, secret) => (secret ? text_.split(secret).join('[redacted]') : text_), message);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isInvalidSession = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ERROR_HTTP_500' && error.message.includes('INVALID_SESSION_ID');

const attemptExecute = async (
  connection: ApexSoapConnection,
  apexCode: string,
  logCategories: ApexLogCategory[],
  usedTokens: string[]
): Promise<ExecuteAnonymousResponse> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken = connection.accessToken ?? '';
    usedTokens.push(accessToken);

    try {
      // Each attempt depends on the last one failing, so they cannot run in parallel.
      // eslint-disable-next-line no-await-in-loop
      const soapResponse = await connection.request<unknown>({
        method: 'POST',
        url: `${connection.instanceUrl}/services/Soap/s/${connection.version}/${accessToken.split('!')[0]}`,
        body: buildExecuteAnonymousEnvelope(accessToken, apexCode, logCategories),
        headers: { 'content-type': 'text/xml', soapaction: SOAP_ACTION },
      });

      return parseExecuteAnonymousResponse(soapResponse);
    } catch (error) {
      if (!isInvalidSession(error)) {
        throw new Error(`Unexpected error while executing anonymous apex. ${errorMessage(error)}`);
      }

      // A GET on the REST base URL makes jsforce refresh the token, as apex-node's refreshAuth does.
      // eslint-disable-next-line no-await-in-loop
      await connection.request({ method: 'GET', url: connection.baseUrl() });
    }
  }

  throw new Error('The authentication for execute anonymous failed');
};

/**
 * Runs anonymous Apex over the SOAP API with the given log categories, retrying once after a
 * token refresh when the session is invalid, as apex-node does. Error messages never carry the
 * access token.
 */
export const executeAnonymousWithCategories = async (
  connection: ApexSoapConnection,
  apexCode: string,
  logCategories: ApexLogCategory[]
): Promise<ExecuteAnonymousResponse> => {
  const usedTokens: string[] = [];

  try {
    return await attemptExecute(connection, apexCode, logCategories, usedTokens);
  } catch (error) {
    throw new Error(redact(errorMessage(error), [...usedTokens, connection.accessToken]));
  }
};

/** Runs anonymous Apex through apex-node, which always logs at `DEBUGONLY`. */
export type ApexNodeExecute = (apexCode: string) => Promise<ExecuteAnonymousResponse>;

/**
 * Runs anonymous Apex at a log detail: `debug` through apex-node, unchanged, and `fine` or
 * `finest` through the plugin's own SOAP call.
 */
export const executeAnonymousAtDetail = (
  connection: ApexSoapConnection,
  apexCode: string,
  detail: ApexLogDetail,
  viaApexNode: ApexNodeExecute
): Promise<ExecuteAnonymousResponse> =>
  detail === 'debug'
    ? viaApexNode(apexCode)
    : executeAnonymousWithCategories(connection, apexCode, APEX_LOG_CATEGORIES[detail]);
