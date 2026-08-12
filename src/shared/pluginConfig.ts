import { SfProject } from '@salesforce/core';

/**
 * Everything this plugin stores under `plugins.sf-raven` in sfdx-project.json.
 * The config is committed with the project, so settings are shared with the team.
 */
export type RavenPluginConfig = {
  pullRemote?: {
    metadataTypes?: string[];
  };
  open?: {
    aliases?: Record<string, string>;
  };
  profileSync?: {
    excludedSections?: string[];
  };
};

export const pluginName = 'sf-raven';

export const resolveProject = async (projectRoot: string): Promise<SfProject | undefined> => {
  try {
    return await SfProject.resolve(projectRoot);
  } catch {
    return undefined;
  }
};

export const getRavenPluginConfig = async (project: SfProject): Promise<Readonly<RavenPluginConfig>> => {
  try {
    return await project.getPluginConfiguration<RavenPluginConfig>(pluginName);
  } catch (error) {
    if (isMissingPluginConfigError(error)) {
      return {};
    }

    throw error;
  }
};

/** Reads the plugin config, treating "not in a project" as "no config". */
export const readRavenPluginConfig = async (projectRoot: string): Promise<Readonly<RavenPluginConfig>> => {
  const project = await resolveProject(projectRoot);

  return project == null ? {} : getRavenPluginConfig(project);
};

const isMissingPluginConfigError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NoPluginsDefined' || error.name === 'PluginNotFound');
