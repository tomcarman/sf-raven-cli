import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncProfiles, type ProfileMetadata } from '../../src/shared/profileSync.js';

const staleProfileXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <custom>true</custom>\n</Profile>\n';

const objectXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Widget</label>\n</CustomObject>\n';

const fieldXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Count__c</fullName>\n    <type>Number</type>\n</CustomField>\n';

const createProject = (): string => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sf-raven-profile-sync-test-'));

  writeFileSync(
    join(projectRoot, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '61.0' }, null, 2)
  );

  const defaultDir = join(projectRoot, 'force-app', 'main', 'default');
  const profilesDir = join(defaultDir, 'profiles');
  const classesDir = join(defaultDir, 'classes');
  const widgetDir = join(defaultDir, 'objects', 'Widget__c');
  const widgetFieldsDir = join(widgetDir, 'fields');
  const accountDir = join(defaultDir, 'objects', 'Account');
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(classesDir, { recursive: true });
  mkdirSync(widgetFieldsDir, { recursive: true });
  mkdirSync(accountDir, { recursive: true });

  writeFileSync(join(profilesDir, 'Admin.profile-meta.xml'), staleProfileXml);
  writeFileSync(join(classesDir, 'TrackedClass.cls'), 'public class TrackedClass {}\n');
  writeFileSync(
    join(classesDir, 'TrackedClass.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>61.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n'
  );
  writeFileSync(join(widgetDir, 'Widget__c.object-meta.xml'), objectXml);
  writeFileSync(join(widgetFieldsDir, 'Count__c.field-meta.xml'), fieldXml);
  writeFileSync(join(accountDir, 'Account.object-meta.xml'), objectXml);

  return projectRoot;
};

const readerFor =
  (profiles: ProfileMetadata[]) =>
  (): Promise<ProfileMetadata[]> =>
    Promise.resolve(profiles);

describe('profile sync', () => {
  const projectRoots: string[] = [];

  const trackProject = (projectRoot: string): string => {
    projectRoots.push(projectRoot);
    return projectRoot;
  };

  after(() => {
    for (const projectRoot of projectRoots) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rewrites the tracked profile file with canonically serialized org content', async () => {
    const projectRoot = trackProject(createProject());
    const orgProfile: ProfileMetadata = {
      fullName: 'Admin',
      userPermissions: [
        { name: 'ViewSetup', enabled: 'true' },
        { name: 'ApiEnabled', enabled: 'true' },
      ],
      userLicense: 'Salesforce',
      loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255', description: 'Office' }],
      custom: 'false',
    };

    await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });

    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <custom>false</custom>',
      '    <loginIpRanges>',
      '        <description>Office</description>',
      '        <endAddress>10.0.0.255</endAddress>',
      '        <startAddress>10.0.0.1</startAddress>',
      '    </loginIpRanges>',
      '    <userLicense>Salesforce</userLicense>',
      '    <userPermissions>',
      '        <enabled>true</enabled>',
      '        <name>ApiEnabled</name>',
      '    </userPermissions>',
      '    <userPermissions>',
      '        <enabled>true</enabled>',
      '        <name>ViewSetup</name>',
      '    </userPermissions>',
      '</Profile>',
      '',
    ].join('\n');

    assert.equal(readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), 'utf8'), expected);
  });

  it('keeps entries for tracked components (including negatives) and drops org-only entries', async () => {
    const projectRoot = trackProject(createProject());
    const orgProfile: ProfileMetadata = {
      fullName: 'Admin',
      classAccesses: [
        { apexClass: 'OrgOnlyClass', enabled: 'true' },
        { apexClass: 'TrackedClass', enabled: 'false' },
      ],
      custom: 'false',
      fieldPermissions: [
        { field: 'Widget__c.Count__c', editable: 'false', readable: 'false' },
        { field: 'Account.Industry', editable: 'true', readable: 'true' },
        { field: 'OrgOnly__c.Stuff__c', editable: 'true', readable: 'true' },
      ],
      objectPermissions: [
        {
          allowCreate: 'true',
          allowDelete: 'true',
          allowEdit: 'true',
          allowRead: 'true',
          modifyAllRecords: 'true',
          object: 'OrgOnly__c',
          viewAllRecords: 'true',
        },
        {
          allowCreate: 'false',
          allowDelete: 'false',
          allowEdit: 'true',
          allowRead: 'true',
          modifyAllRecords: 'false',
          object: 'Widget__c',
          viewAllRecords: 'true',
        },
      ],
      recordTypeVisibilities: [{ default: 'true', recordType: 'Widget__c.Standard', visible: 'true' }],
      tabVisibilities: [{ tab: 'Widget__c', visibility: 'DefaultOn' }],
      userLicense: 'Salesforce',
      userPermissions: [{ name: 'ApiEnabled', enabled: 'true' }],
    };

    await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });

    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <classAccesses>',
      '        <apexClass>TrackedClass</apexClass>',
      '        <enabled>false</enabled>',
      '    </classAccesses>',
      '    <custom>false</custom>',
      '    <fieldPermissions>',
      '        <editable>true</editable>',
      '        <field>Account.Industry</field>',
      '        <readable>true</readable>',
      '    </fieldPermissions>',
      '    <fieldPermissions>',
      '        <editable>false</editable>',
      '        <field>Widget__c.Count__c</field>',
      '        <readable>false</readable>',
      '    </fieldPermissions>',
      '    <objectPermissions>',
      '        <allowCreate>false</allowCreate>',
      '        <allowDelete>false</allowDelete>',
      '        <allowEdit>true</allowEdit>',
      '        <allowRead>true</allowRead>',
      '        <modifyAllRecords>false</modifyAllRecords>',
      '        <object>Widget__c</object>',
      '        <viewAllRecords>true</viewAllRecords>',
      '    </objectPermissions>',
      '    <userLicense>Salesforce</userLicense>',
      '    <userPermissions>',
      '        <enabled>true</enabled>',
      '        <name>ApiEnabled</name>',
      '    </userPermissions>',
      '</Profile>',
      '',
    ].join('\n');

    assert.equal(readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), 'utf8'), expected);
  });

  it('requests the named profiles from the injected reader and reports the synced file', async () => {
    const projectRoot = trackProject(createProject());
    const requestedNames: string[][] = [];
    const readProfiles = (profileNames: string[]): Promise<ProfileMetadata[]> => {
      requestedNames.push(profileNames);
      return Promise.resolve([{ fullName: 'Admin', custom: 'false' }]);
    };

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles });

    assert.deepEqual(requestedNames, [['Admin']]);
    assert.deepEqual(result, {
      synced: [{ name: 'Admin', path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml') }],
    });
  });

  it('rejects a profile that is not tracked in local source without touching the org', async () => {
    const projectRoot = trackProject(createProject());
    let readerCalled = false;
    const readProfiles = (): Promise<ProfileMetadata[]> => {
      readerCalled = true;
      return Promise.resolve([]);
    };

    await assert.rejects(syncProfiles({ projectRoot, profileNames: ['Untracked'], readProfiles }), {
      message: 'Profile "Untracked" is not tracked in local source.',
    });
    assert.equal(readerCalled, false);
  });

  it('rejects a tracked profile that the org does not return', async () => {
    const projectRoot = trackProject(createProject());

    await assert.rejects(syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([]) }), {
      message: 'Profile "Admin" was not found in the org.',
    });
    assert.equal(
      readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), 'utf8'),
      staleProfileXml
    );
  });
});
