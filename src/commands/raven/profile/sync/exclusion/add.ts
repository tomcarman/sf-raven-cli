import { Args } from '@oclif/core';
import { Messages } from '@salesforce/core';
import { SfCommand, Ux } from '@salesforce/sf-plugins-core';
import { normalizeSectionNames } from '../../../../../shared/profileSync.js';
import { addExcludedSections } from '../../../../../shared/profileSyncConfig.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sf-raven-cli', 'raven.profile.sync.exclusion.add');

export type RavenProfileSyncExclusionAddResult = {
  addedSections: string[];
  excludedSections: string[];
};

export default class RavenProfileSyncExclusionAdd extends SfCommand<RavenProfileSyncExclusionAddResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  public static readonly strict = false;

  public static readonly args = {
    sections: Args.string({ description: messages.getMessage('args.sections.description'), required: true }),
  };

  public async run(): Promise<RavenProfileSyncExclusionAddResult> {
    const { argv } = await this.parse(RavenProfileSyncExclusionAdd);
    const ux = new Ux({ jsonEnabled: this.jsonEnabled() });
    const addedSections = normalizeSectionNames(argv.map((value) => String(value).split(',')).flat());

    if (addedSections.length === 0) {
      throw messages.createError('error.noSections');
    }

    const excludedSections = await addExcludedSections(process.cwd(), addedSections);

    ux.log(messages.getMessage('info.addedSections', [addedSections.join(', ')]));
    ux.log(messages.getMessage('info.excludedSections', [excludedSections.join(', ')]));

    return { addedSections, excludedSections };
  }
}
