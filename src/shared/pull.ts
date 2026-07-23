import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SfProject } from '@salesforce/core';
import { ComponentSet, type MetadataComponent } from '@salesforce/source-deploy-retrieve';

export type SelectedMetadata = {
  sourceDirs: string[];
  metadataNames: string[];
};

export type PullListSource = 'configured' | 'local' | 'org';

export type PullListType = {
  name: string;
  localCount?: number;
};

export type PullListTypesResult = {
  source: PullListSource;
  types: PullListType[];
};

export type PullListComponentStatus = 'local' | 'remote' | 'both';

export type PullListComponent = {
  name: string;
  status: PullListComponentStatus;
};

export type PullListComponentsResult = {
  metadataType: string;
  components: PullListComponent[];
};

type SfdxProject = {
  packageDirectories?: Array<{
    path?: string;
    default?: boolean;
  }>;
};

type PackageDirectory = {
  path: string;
  default?: boolean;
};

type ChildProcessResult = {
  stdout: string;
  exitCode: number;
};

type MetadataListResult = {
  result?: MetadataListComponent[] | MetadataListComponent;
};

type MetadataListComponent = {
  fullName?: string;
};

type MetadataTypesResult = {
  result?: MetadataTypesPayload | MetadataTypeDescription[];
};

type MetadataTypesPayload = {
  metadataObjects?: MetadataTypeDescription[];
};

type MetadataTypeDescription = {
  xmlName?: string;
  metadataType?: string;
  name?: string;
  type?: string;
};

type RavenPluginConfig = {
  pullRemote?: {
    metadataTypes?: string[];
  };
};

const ignoredDirectoryNames = new Set(['.git', 'node_modules', '.sfdx', '.sf']);
const pluginName = 'sf-raven';

export const getExistingPackageDirectoryPaths = (projectRoot: string): string[] =>
  getPackageDirectoryPaths(projectRoot).filter((packageDirectoryPath) => existsSync(join(projectRoot, packageDirectoryPath)));

export const getMetadataPaths = (projectRoot: string): string[] => {
  const packageDirectoryPaths = getExistingPackageDirectoryPaths(projectRoot);
  const metadataPaths = new Set<string>();

  for (const packageDirectoryPath of packageDirectoryPaths) {
    metadataPaths.add(packageDirectoryPath);
    collectPaths(projectRoot, packageDirectoryPath, metadataPaths);
  }

  return Array.from(metadataPaths).sort((left, right) => left.localeCompare(right));
};

export const selectItems = async (items: string[]): Promise<string[]> => {
  const result = await runChildProcess('fzf', ['--multi'], {
    input: items.join('\n'),
    stderr: 'inherit',
  });

  const selectedItems = result.stdout
    .split('\n')
    .map((selectedItem) => selectedItem.trim())
    .filter((selectedItem) => selectedItem.length > 0);

  if (result.exitCode !== 0) {
    return [];
  }

  return selectedItems;
};

export const getEffectiveRemoteMetadataTypes = async (projectRoot: string): Promise<string[]> => {
  const configuredMetadataTypes = await getConfiguredRemoteMetadataTypes(projectRoot);

  if (configuredMetadataTypes !== undefined) {
    return configuredMetadataTypes;
  }

  return getLocalMetadataTypes(projectRoot);
};

export const addRemoteMetadataTypes = async (projectRoot: string, metadataTypes: string[]): Promise<string[]> => {
  const existingMetadataTypes = await getEffectiveRemoteMetadataTypes(projectRoot);
  const updatedMetadataTypes = sortValues([...existingMetadataTypes, ...metadataTypes]);
  await writeRemoteMetadataTypes(projectRoot, updatedMetadataTypes);

  return updatedMetadataTypes;
};

export const removeRemoteMetadataTypes = async (projectRoot: string, metadataTypes: string[]): Promise<string[]> => {
  const metadataTypesToRemove = new Set(metadataTypes);
  const updatedMetadataTypes = (await getEffectiveRemoteMetadataTypes(projectRoot)).filter((metadataType) => !metadataTypesToRemove.has(metadataType));
  await writeRemoteMetadataTypes(projectRoot, updatedMetadataTypes);

  return updatedMetadataTypes;
};

export const listOrgMetadataTypes = async (targetOrg?: string): Promise<string[]> => {
  const args = ['org', 'list', 'metadata-types', '--json'];

  if (targetOrg != null && targetOrg.length > 0) {
    args.push('--target-org', targetOrg);
  }

  const result = await runSfCommand(args, {
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    return [];
  }

  if (!result.stdout.trim()) {
    return [];
  }

  const parsedResult = JSON.parse(result.stdout) as MetadataTypesResult;
  const metadataTypes = Array.isArray(parsedResult.result) ? parsedResult.result : parsedResult.result?.metadataObjects ?? [];

  return sortValues(metadataTypes.map(getMetadataTypeName).filter((metadataType): metadataType is string => metadataType != null));
};

export const getTypeInventory = async (projectRoot: string): Promise<PullListTypesResult> => {
  const configuredMetadataTypes = await getConfiguredRemoteMetadataTypes(projectRoot);
  const localCounts = getLocalMetadataTypeCounts(projectRoot);

  if (configuredMetadataTypes !== undefined) {
    return {
      source: 'configured',
      types: toTypesWithLocalCounts(configuredMetadataTypes, localCounts),
    };
  }

  return {
    source: 'local',
    types: toTypesWithLocalCounts(sortValues(localCounts.keys()), localCounts),
  };
};

export const getOrgTypeInventory = async (targetOrg?: string): Promise<PullListTypesResult> => ({
  source: 'org',
  types: (await listOrgMetadataTypes(targetOrg)).map((name) => ({ name })),
});

export const getComponentInventory = async (
  projectRoot: string,
  metadataType: string,
  targetOrg?: string
): Promise<PullListComponentsResult> => {
  const localFullNames = getLocalMetadataFullNames(projectRoot, metadataType);
  const orgFullNames = await listOrgMetadataFullNames(metadataType, targetOrg);

  const componentStatus = (name: string): PullListComponentStatus => {
    if (localFullNames.has(name) && orgFullNames.has(name)) {
      return 'both';
    }

    return localFullNames.has(name) ? 'local' : 'remote';
  };

  return {
    metadataType,
    components: sortValues([...localFullNames, ...orgFullNames]).map((name) => ({ name, status: componentStatus(name) })),
  };
};

export const getOrgOnlyMetadataNamesForType = async (
  projectRoot: string,
  metadataType: string,
  targetOrg?: string
): Promise<string[]> => {
  const localMetadataNames = getLocalMetadataNames(projectRoot, metadataType);
  const orgMetadataNames = new Set<string>();

  for (const fullName of await listOrgMetadataFullNames(metadataType, targetOrg)) {
    const metadataName = formatMetadataName(metadataType, fullName);

    if (!localMetadataNames.has(metadataName)) {
      orgMetadataNames.add(metadataName);
    }
  }

  return Array.from(orgMetadataNames).sort((left, right) => left.localeCompare(right));
};

export const retrieveSourceDirs = async (sourceDirs: string[], targetOrg?: string): Promise<number> => {
  const args = ['project', 'retrieve', 'start'];

  if (targetOrg != null && targetOrg.length > 0) {
    args.push('--target-org', targetOrg);
  }

  for (const sourceDir of sourceDirs) {
    args.push('--source-dir', sourceDir);
  }

  return runRetrieveCommand(args);
};

export const retrieveMetadataNames = async (metadataNames: string[], targetOrg?: string): Promise<number> => {
  const args = ['project', 'retrieve', 'start'];

  if (targetOrg != null && targetOrg.length > 0) {
    args.push('--target-org', targetOrg);
  }

  for (const metadataName of metadataNames) {
    args.push('--metadata', metadataName);
  }

  return runRetrieveCommand(args);
};

const toTypesWithLocalCounts = (names: string[], localCounts: Map<string, number>): PullListType[] =>
  names.map((name) => ({ name, localCount: localCounts.get(name) ?? 0 }));

const listOrgMetadataFullNames = async (metadataType: string, targetOrg?: string): Promise<Set<string>> => {
  const fullNames = new Set<string>();

  for (const component of await listOrgMetadata(metadataType, targetOrg)) {
    if (component.fullName != null && component.fullName.length > 0) {
      fullNames.add(component.fullName);
    }
  }

  return fullNames;
};

const listOrgMetadata = async (metadataType: string, targetOrg?: string): Promise<MetadataListComponent[]> => {
  const args = ['org', 'list', 'metadata', '--metadata-type', metadataType, '--json'];

  if (targetOrg != null && targetOrg.length > 0) {
    args.push('--target-org', targetOrg);
  }

  const result = await runSfCommand(args, {
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    return [];
  }

  if (!result.stdout.trim()) {
    return [];
  }

  const parsedResult = JSON.parse(result.stdout) as MetadataListResult;
  const components = parsedResult.result;

  if (components == null) {
    return [];
  }

  return Array.isArray(components) ? components : [components];
};

const runRetrieveCommand = async (args: string[]): Promise<number> => {
  const result = await runSfCommand(args, {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  return result.exitCode;
};

const runSfCommand = async (
  args: string[],
  options: {
    stdout?: 'inherit';
    stderr?: 'inherit' | 'pipe';
  } = {}
): Promise<ChildProcessResult> => runChildProcess(process.env.SF_BINPATH ?? 'sf', args, options);

const runChildProcess = async (
  command: string,
  args: string[],
  options: {
    input?: string;
    stdout?: 'inherit';
    stderr?: 'inherit' | 'pipe';
  } = {}
): Promise<ChildProcessResult> =>
  new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      stdio: ['pipe', options.stdout === 'inherit' ? 'inherit' : 'pipe', options.stderr === 'inherit' ? 'inherit' : 'pipe'],
      env: process.env,
    });

    let stdout = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.on('error', (error) => {
      reject(error);
    });

    childProcess.on('close', (code) => {
      resolve({
        stdout,
        exitCode: code ?? 1,
      });
    });

    if (options.input != null) {
      childProcess.stdin?.write(options.input);
    }

    childProcess.stdin?.end();
  });

const getConfiguredRemoteMetadataTypes = async (projectRoot: string): Promise<string[] | undefined> => {
  const project = await resolveProject(projectRoot);

  if (project == null) {
    return undefined;
  }

  const config = await getRavenPluginConfig(project);
  const metadataTypes = config.pullRemote?.metadataTypes;

  return Array.isArray(metadataTypes) ? sortValues(metadataTypes.filter((metadataType): metadataType is string => typeof metadataType === 'string')) : undefined;
};

const writeRemoteMetadataTypes = async (projectRoot: string, metadataTypes: string[]): Promise<void> => {
  const project = await SfProject.resolve(projectRoot);
  const config = await getRavenPluginConfig(project);

  await project.setPluginConfiguration<RavenPluginConfig>(pluginName, {
    ...config,
    pullRemote: {
      ...config.pullRemote,
      metadataTypes: sortValues(metadataTypes),
    },
  });
};

const getRavenPluginConfig = async (project: SfProject): Promise<Readonly<RavenPluginConfig>> => {
  try {
    return await project.getPluginConfiguration<RavenPluginConfig>(pluginName);
  } catch (error) {
    if (isMissingPluginConfigError(error)) {
      return {};
    }

    throw error;
  }
};

const isMissingPluginConfigError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NoPluginsDefined' || error.name === 'PluginNotFound');

const resolveProject = async (projectRoot: string): Promise<SfProject | undefined> => {
  try {
    return await SfProject.resolve(projectRoot);
  } catch {
    return undefined;
  }
};

const getLocalMetadataTypes = (projectRoot: string): string[] => {
  const metadataTypes = new Set<string>();

  for (const component of getLocalMetadataComponents(projectRoot)) {
    metadataTypes.add(component.type.name);
  }

  return sortValues(metadataTypes);
};

const getLocalMetadataNames = (projectRoot: string, metadataType: string): Set<string> =>
  new Set(Array.from(getLocalMetadataFullNames(projectRoot, metadataType)).map((fullName) => formatMetadataName(metadataType, fullName)));

const getLocalMetadataFullNames = (projectRoot: string, metadataType: string): Set<string> => {
  const localMetadataFullNames = new Set<string>();

  for (const component of getLocalMetadataComponents(projectRoot)) {
    if (component.type.name === metadataType && component.fullName.length > 0) {
      localMetadataFullNames.add(component.fullName);
    }
  }

  return localMetadataFullNames;
};

const getLocalMetadataTypeCounts = (projectRoot: string): Map<string, number> => {
  const localCounts = new Map<string, number>();

  for (const component of getLocalMetadataComponents(projectRoot)) {
    localCounts.set(component.type.name, (localCounts.get(component.type.name) ?? 0) + 1);
  }

  return localCounts;
};

const formatMetadataName = (metadataType: string, fullName: string): string => `${metadataType}:${fullName}`;

export const getLocalMetadataComponents = (projectRoot: string): MetadataComponent[] => {
  const sourcePaths = getExistingPackageDirectoryPaths(projectRoot).map((packageDirectoryPath) => join(projectRoot, packageDirectoryPath));

  if (sourcePaths.length === 0) {
    return [];
  }

  return ComponentSet.fromSource(sourcePaths)
    .toArray()
    .filter((component) => component.type.isAddressable !== false);
};

export const isPromptForceCloseError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ExitPromptError';

const getMetadataTypeName = (metadataType: MetadataTypeDescription): string | undefined =>
  metadataType.xmlName ?? metadataType.metadataType ?? metadataType.name ?? metadataType.type;

const sortValues = (values: Iterable<string>): string[] =>
  Array.from(new Set(Array.from(values).filter((value) => value.length > 0))).sort((left, right) => left.localeCompare(right));

export const getDefaultPackageDirectoryPath = (projectRoot: string): string => {
  const packageDirectories = getPackageDirectories(projectRoot);

  return (packageDirectories.find((packageDirectory) => packageDirectory.default === true) ?? packageDirectories[0]).path;
};

const getPackageDirectoryPaths = (projectRoot: string): string[] =>
  getPackageDirectories(projectRoot).map((packageDirectory) => packageDirectory.path);

const getPackageDirectories = (projectRoot: string): PackageDirectory[] => {
  const sfdxProjectPath = join(projectRoot, 'sfdx-project.json');

  if (!existsSync(sfdxProjectPath)) {
    return [{ path: existsSync(join(projectRoot, 'force-app')) ? 'force-app' : '.' }];
  }

  const sfdxProject = JSON.parse(readFileSync(sfdxProjectPath, 'utf8')) as SfdxProject;
  const packageDirectories = (sfdxProject.packageDirectories ?? []).filter(
    (packageDirectory): packageDirectory is PackageDirectory => packageDirectory.path != null
  );

  return packageDirectories.length > 0 ? packageDirectories : [{ path: 'force-app' }];
};

const collectPaths = (projectRoot: string, currentPath: string, metadataPaths: Set<string>): void => {
  const absolutePath = join(projectRoot, currentPath);

  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
      continue;
    }

    const relativePath = relative(projectRoot, join(absolutePath, entry.name));

    if (entry.isDirectory()) {
      metadataPaths.add(relativePath);
      collectPaths(projectRoot, relativePath, metadataPaths);
    } else if (entry.isFile() && statSync(join(projectRoot, relativePath)).size > 0) {
      metadataPaths.add(relativePath);
    }
  }
};
