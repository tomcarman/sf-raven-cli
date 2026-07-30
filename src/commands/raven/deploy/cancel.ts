import { spawn } from 'node:child_process';
import select, { Separator } from '@inquirer/select';
import { Messages } from '@salesforce/core';
import { Flags, SfCommand, Ux } from '@salesforce/sf-plugins-core';
import dayjs from 'dayjs';
import { isPromptForceCloseError } from '../../../shared/pull.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.deploy.cancel');

export type DeployCancelResult = {
  cancelled: boolean;
  jobId?: string;
  targetOrg?: string;
};

type DeployRequestQueryResult = {
  records: DeployRequestRecord[];
};

type DeployRequestRecord = {
  Id: string;
  Status: string;
  StartDate?: string | null;
  NumberComponentsDeployed?: number | null;
  NumberComponentsTotal?: number | null;
  NumberComponentErrors?: number | null;
  NumberTestsCompleted?: number | null;
  NumberTestsTotal?: number | null;
  NumberTestErrors?: number | null;
};

type ToolingConnection = {
  tooling: {
    query: (query: string) => Promise<DeployRequestQueryResult>;
  };
};

type ChildProcessResult = {
  exitCode: number;
};

const cancelSelection = 'cancel' as const;

type DeploySelection = DeployRequestRecord | typeof cancelSelection;
type DeployChoice = Separator | { name: string; value: DeploySelection };
type SelectPrompt = <Value>(config: {
  message: string;
  choices: readonly unknown[];
  pageSize?: number;
}) => Promise<Value>;

const selectPrompt = select as unknown as SelectPrompt;

export default class DeployCancel extends SfCommand<DeployCancelResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.optionalOrg({
      summary: messages.getMessage('flags.target-org.summary'),
      char: 'o',
    }),
  };

  public async run(): Promise<DeployCancelResult> {
    const { flags } = await this.parse(DeployCancel);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const org = flags['target-org'];

    if (org == null) {
      throw messages.createError('error.noTargetOrg');
    }

    const targetOrg = org.getUsername();

    if (targetOrg == null) {
      throw messages.createError('error.noTargetOrg');
    }

    ux.spinner.start(messages.getMessage('info.loadingDeploys'));

    let deployRequests: DeployRequestRecord[];

    try {
      deployRequests = await getActiveDeployRequests(org.getConnection() as unknown as ToolingConnection);
    } finally {
      ux.spinner.stop();
    }

    if (deployRequests.length === 0) {
      ux.log(messages.getMessage('info.noDeploys'));
      return {
        cancelled: false,
        targetOrg,
      };
    }

    const selectedDeployRequest = await selectDeployRequest(deployRequests);

    if (selectedDeployRequest === cancelSelection || selectedDeployRequest == null) {
      ux.log(messages.getMessage('info.noSelection'));
      return {
        cancelled: false,
        targetOrg,
      };
    }

    const confirmed = await this.confirm({
      message: messages.getMessage('prompt.confirmCancel', [selectedDeployRequest.Id]),
      defaultAnswer: false,
    });

    if (!confirmed) {
      ux.log(messages.getMessage('info.cancelAborted'));
      return {
        cancelled: false,
        jobId: selectedDeployRequest.Id,
        targetOrg,
      };
    }

    const exitCode = await cancelDeploy(selectedDeployRequest.Id, targetOrg);

    if (exitCode !== 0) {
      throw messages.createError('error.cancelFailed', [exitCode.toString()]);
    }

    ux.log(messages.getMessage('info.cancelSubmitted', [selectedDeployRequest.Id]));

    return {
      cancelled: true,
      jobId: selectedDeployRequest.Id,
      targetOrg,
    };
  }
}

const getActiveDeployRequests = async (connection: ToolingConnection): Promise<DeployRequestRecord[]> => {
  const result = await connection.tooling.query(`
    SELECT Id, Status, StartDate,
           NumberComponentsDeployed, NumberComponentsTotal, NumberComponentErrors,
           NumberTestsCompleted, NumberTestsTotal, NumberTestErrors
    FROM DeployRequest
    WHERE Status IN ('InProgress', 'Pending')
    ORDER BY StartDate DESC
  `);

  return result.records;
};

const formatDeployRequest = (deployRequest: DeployRequestRecord): string => {
  if (deployRequest.Status === 'Pending') {
    return [deployRequest.Status, deployRequest.Id].join(' | ');
  }

  const startDate =
    deployRequest.StartDate == null
      ? messages.getMessage('label.unknownStartDate')
      : dayjs(deployRequest.StartDate).format('DD/MM/YYYY HH:mm');

  return [
    startDate,
    deployRequest.Status,
    deployRequest.Id,
    `Metadata: ${formatProgress(
      deployRequest.NumberComponentsDeployed,
      deployRequest.NumberComponentsTotal,
      deployRequest.NumberComponentErrors
    )}`,
    `Apex Tests: ${formatProgress(
      deployRequest.NumberTestsCompleted,
      deployRequest.NumberTestsTotal,
      deployRequest.NumberTestErrors
    )}`,
  ].join(' | ');
};

const selectDeployRequest = async (deployRequests: DeployRequestRecord[]): Promise<DeploySelection | undefined> => {
  try {
    return await selectPrompt<DeploySelection>({
      message: messages.getMessage('prompt.selectDeploy'),
      choices: getDeployChoices(deployRequests),
      pageSize: 10,
    });
  } catch (error) {
    if (isPromptForceCloseError(error)) {
      return undefined;
    }

    throw error;
  }
};

const getDeployChoices = (deployRequests: DeployRequestRecord[]): DeployChoice[] => {
  const inProgressDeployRequests = deployRequests.filter((deployRequest) => deployRequest.Status === 'InProgress');
  const pendingDeployRequests = deployRequests.filter((deployRequest) => deployRequest.Status === 'Pending');

  return [
    { name: messages.getMessage('label.cancel'), value: cancelSelection },
    new Separator(),
    ...getGroupedDeployChoices(messages.getMessage('label.inProgress'), inProgressDeployRequests),
    ...getGroupedDeployChoices(messages.getMessage('label.pending'), pendingDeployRequests),
  ];
};

const getGroupedDeployChoices = (label: string, deployRequests: DeployRequestRecord[]): DeployChoice[] =>
  deployRequests.length === 0
    ? []
    : [
        new Separator(label),
        ...deployRequests.map((deployRequest) => ({
          name: formatDeployRequest(deployRequest),
          value: deployRequest,
        })),
      ];

const formatProgress = (completed?: number | null, total?: number | null, errors?: number | null): string => {
  const completedValue = completed ?? 0;
  const totalValue = total ?? 0;
  const errorValue = errors ?? 0;
  const percentage = totalValue > 0 ? Math.floor((completedValue / totalValue) * 100) : 0;

  return `${completedValue}/${totalValue} (${percentage}% - ${errorValue} errors)`;
};

const cancelDeploy = async (jobId: string, targetOrg: string): Promise<number> => {
  const result = await runChildProcess(process.env.SF_BINPATH ?? 'sf', [
    'project',
    'deploy',
    'cancel',
    '--job-id',
    jobId,
    '--target-org',
    targetOrg,
    '--async',
  ]);

  return result.exitCode;
};

const runChildProcess = async (command: string, args: string[]): Promise<ChildProcessResult> =>
  new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    childProcess.on('error', (error) => {
      reject(error);
    });

    childProcess.on('close', (code) => {
      resolve({
        exitCode: code ?? 0,
      });
    });
  });
