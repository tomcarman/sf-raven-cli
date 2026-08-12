import { Args } from '@oclif/core';
import { Messages } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { normalizeSectionNames } from '../../../../../shared/profileSync.js';
import { removeExcludedSections } from '../../../../../shared/profileSyncConfig.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.profile.sync.exclusion.remove');

export type RavenProfileSyncExclusionRemoveResult = {
  removedSections: string[];
  missingSections: string[];
  excludedSections: string[];
};

export default class RavenProfileSyncExclusionRemove extends SfCommand<RavenProfileSyncExclusionRemoveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly strict = false;

  public static readonly args = {
    sections: Args.string({ description: messages.getMessage('args.sections.description'), required: true }),
  };

  public async run(): Promise<RavenProfileSyncExclusionRemoveResult> {
    const { argv } = await this.parse(RavenProfileSyncExclusionRemove);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const requestedSections = normalizeSectionNames(argv.map((value) => String(value).split(',')).flat());

    if (requestedSections.length === 0) {
      throw messages.createError('error.noSections');
    }

    const { excludedSections, removedSections, missingSections } = await removeExcludedSections(
      process.cwd(),
      requestedSections
    );

    for (const sectionName of missingSections) {
      this.warn(messages.getMessage('warning.notExcluded', [sectionName]));
    }

    if (removedSections.length > 0) {
      ux.log(messages.getMessage('info.removedSections', [removedSections.join(', ')]));
    }

    ux.log(
      excludedSections.length > 0
        ? messages.getMessage('info.excludedSections', [excludedSections.join(', ')])
        : messages.getMessage('info.noExclusions')
    );

    return { removedSections, missingSections, excludedSections };
  }
}
