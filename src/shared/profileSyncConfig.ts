import { SfProject } from '@salesforce/core';
import { getRavenPluginConfig, pluginName, readRavenPluginConfig, type RavenPluginConfig } from './pluginConfig.js';
import { normalizeSectionNames } from './profileSync.js';

export type RemoveExcludedSectionsResult = {
  excludedSections: string[];
  removedSections: string[];
  missingSections: string[];
};

export const getConfiguredExcludedSections = async (projectRoot: string): Promise<string[]> => {
  const excludedSections = (await readRavenPluginConfig(projectRoot)).profileSync?.excludedSections;

  return Array.isArray(excludedSections)
    ? normalizeSectionNames(
        excludedSections.filter((sectionName): sectionName is string => typeof sectionName === 'string')
      )
    : [];
};

export const addExcludedSections = async (projectRoot: string, sectionNames: string[]): Promise<string[]> => {
  const excludedSections = normalizeSectionNames([
    ...(await getConfiguredExcludedSections(projectRoot)),
    ...sectionNames,
  ]);
  await writeExcludedSections(projectRoot, excludedSections);

  return excludedSections;
};

export const removeExcludedSections = async (
  projectRoot: string,
  sectionNames: string[]
): Promise<RemoveExcludedSectionsResult> => {
  const existingSections = await getConfiguredExcludedSections(projectRoot);
  const existingSectionSet = new Set(existingSections);
  const sectionsToRemove = normalizeSectionNames(sectionNames);
  const removedSections = sectionsToRemove.filter((sectionName) => existingSectionSet.has(sectionName));
  const missingSections = sectionsToRemove.filter((sectionName) => !existingSectionSet.has(sectionName));
  const removedSectionSet = new Set(removedSections);
  const excludedSections = existingSections.filter((sectionName) => !removedSectionSet.has(sectionName));

  if (removedSections.length > 0) {
    await writeExcludedSections(projectRoot, excludedSections);
  }

  return { excludedSections, removedSections, missingSections };
};

const writeExcludedSections = async (projectRoot: string, excludedSections: string[]): Promise<void> => {
  const project = await SfProject.resolve(projectRoot);
  const config = await getRavenPluginConfig(project);

  await project.setPluginConfiguration<RavenPluginConfig>(pluginName, {
    ...config,
    profileSync: {
      ...config.profileSync,
      excludedSections,
    },
  });
};
