import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncProfiles, type ProfileMetadata } from '../../src/shared/profileSync.js';

const staleProfileXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <custom>true</custom>\n</Profile>\n';

const objectXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>Widget</label>\n</CustomObject>\n';

const fieldXml =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Count__c</fullName>\n    <type>Number</type>\n</CustomField>\n';

type ProjectOptions = {
  profiles?: string[];
  otherPackageProfiles?: string[];
  defaultPackageDirectory?: 'force-app' | 'other-app';
};

const createProject = ({ profiles = ['Admin'], otherPackageProfiles = [], defaultPackageDirectory = 'force-app' }: ProjectOptions = {}): string => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'sf-raven-profile-sync-test-'));

  const includeOtherPackage = otherPackageProfiles.length > 0 || defaultPackageDirectory === 'other-app';
  const packageDirectories = [
    { path: 'force-app', default: defaultPackageDirectory === 'force-app' },
    ...(includeOtherPackage ? [{ path: 'other-app', default: defaultPackageDirectory === 'other-app' }] : []),
  ];
  writeFileSync(join(projectRoot, 'sfdx-project.json'), JSON.stringify({ packageDirectories, sourceApiVersion: '61.0' }, null, 2));

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

  for (const profileName of profiles) {
    writeFileSync(join(profilesDir, `${profileName}.profile-meta.xml`), staleProfileXml);
  }

  if (otherPackageProfiles.length > 0) {
    const otherProfilesDir = join(projectRoot, 'other-app', 'main', 'default', 'profiles');
    mkdirSync(otherProfilesDir, { recursive: true });

    for (const profileName of otherPackageProfiles) {
      writeFileSync(join(otherProfilesDir, `${profileName}.profile-meta.xml`), staleProfileXml);
    }
  }
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
      synced: [
        {
          name: 'Admin',
          path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'),
          changed: true,
          changes: [{ section: 'custom', added: 0, removed: 0, modified: 1 }],
        },
      ],
      skipped: [],
      failed: [],
      dryRun: false,
      drifted: true,
    });
  });

  it('syncs every locally tracked profile in place when no names are given, including non-default package directories', async () => {
    const projectRoot = trackProject(createProject({ profiles: ['Admin', 'Support'], otherPackageProfiles: ['Marketing'] }));
    const requestedNames: string[][] = [];
    const readProfiles = (profileNames: string[]): Promise<ProfileMetadata[]> => {
      requestedNames.push(profileNames);
      return Promise.resolve(profileNames.map((name) => ({ fullName: name, custom: 'false' })));
    };

    const result = await syncProfiles({ projectRoot, readProfiles });

    assert.deepEqual(requestedNames, [['Admin', 'Marketing', 'Support']]);
    const customModified = { changed: true, changes: [{ section: 'custom', added: 0, removed: 0, modified: 1 }] };
    assert.deepEqual(result, {
      synced: [
        { name: 'Admin', path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), ...customModified },
        { name: 'Marketing', path: join(projectRoot, 'other-app', 'main', 'default', 'profiles', 'Marketing.profile-meta.xml'), ...customModified },
        { name: 'Support', path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Support.profile-meta.xml'), ...customModified },
      ],
      skipped: [],
      failed: [],
      dryRun: false,
      drifted: true,
    });

    for (const profile of result.synced) {
      assert.notEqual(readFileSync(profile.path, 'utf8'), staleProfileXml);
    }
  });

  it('syncs exactly the named profiles when several are given', async () => {
    const projectRoot = trackProject(createProject({ profiles: ['Admin', 'Support', 'Sales'] }));
    const requestedNames: string[][] = [];
    const readProfiles = (profileNames: string[]): Promise<ProfileMetadata[]> => {
      requestedNames.push(profileNames);
      return Promise.resolve(profileNames.map((name) => ({ fullName: name, custom: 'false' })));
    };

    const result = await syncProfiles({ projectRoot, profileNames: ['Sales', 'Admin'], readProfiles });

    assert.deepEqual(requestedNames, [['Sales', 'Admin']]);
    assert.deepEqual(
      result.synced.map((profile) => profile.name),
      ['Sales', 'Admin']
    );
    assert.equal(readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Support.profile-meta.xml'), 'utf8'), staleProfileXml);
  });

  it('fetches more than 10 profiles in parallel batches of at most 10', async () => {
    const profileNames = Array.from({ length: 11 }, (_, index) => `Profile${String(index).padStart(2, '0')}`);
    const projectRoot = trackProject(createProject({ profiles: profileNames }));
    const requestedNames: string[][] = [];
    let releaseBatches = (): void => {};
    const allBatchesIssued = new Promise<void>((resolve) => {
      releaseBatches = resolve;
    });
    const readProfiles = async (batchNames: string[]): Promise<ProfileMetadata[]> => {
      requestedNames.push(batchNames);

      if (requestedNames.length === 2) {
        releaseBatches();
      }

      // Each batch resolves only once both batches have been issued, so a sequential implementation deadlocks here.
      await Promise.race([
        allBatchesIssued,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('batches were not issued in parallel')), 2000).unref();
        }),
      ]);

      return batchNames.map((name) => ({ fullName: name, custom: 'false' }));
    };

    const result = await syncProfiles({ projectRoot, readProfiles });

    assert.deepEqual(requestedNames, [profileNames.slice(0, 10), profileNames.slice(10)]);
    assert.deepEqual(
      result.synced.map((profile) => profile.name),
      profileNames
    );
  });

  it('skips a tracked profile the org does not return and syncs the rest', async () => {
    const projectRoot = trackProject(createProject({ profiles: ['Admin', 'Ghost'] }));
    const readProfiles = readerFor([{ fullName: 'Admin', custom: 'false' }]);

    const result = await syncProfiles({ projectRoot, readProfiles });

    assert.deepEqual(
      result.synced.map((profile) => profile.name),
      ['Admin']
    );
    assert.deepEqual(result.skipped, [{ name: 'Ghost' }]);
    assert.deepEqual(result.failed, []);
    assert.equal(readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Ghost.profile-meta.xml'), 'utf8'), staleProfileXml);
  });

  it('records a failed batch per profile and still syncs the other batches', async () => {
    const profileNames = Array.from({ length: 11 }, (_, index) => `Profile${String(index).padStart(2, '0')}`);
    const projectRoot = trackProject(createProject({ profiles: profileNames }));
    const readProfiles = (batchNames: string[]): Promise<ProfileMetadata[]> =>
      batchNames.length === 10
        ? Promise.reject(new Error('read timed out'))
        : Promise.resolve(batchNames.map((name) => ({ fullName: name, custom: 'false' })));

    const result = await syncProfiles({ projectRoot, readProfiles });

    assert.deepEqual(
      result.synced.map((profile) => profile.name),
      ['Profile10']
    );
    assert.deepEqual(
      result.failed,
      profileNames.slice(0, 10).map((name) => ({ name, error: 'read timed out' }))
    );
    assert.equal(readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Profile00.profile-meta.xml'), 'utf8'), staleProfileXml);
  });

  it('summarises entries added, removed, and modified per section when syncing', async () => {
    const projectRoot = trackProject(createProject());
    const oldProfileXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <classAccesses>',
      '        <apexClass>TrackedClass</apexClass>',
      '        <enabled>false</enabled>',
      '    </classAccesses>',
      '    <custom>true</custom>',
      '    <fieldPermissions>',
      '        <editable>false</editable>',
      '        <field>Account.Industry</field>',
      '        <readable>true</readable>',
      '    </fieldPermissions>',
      '    <fieldPermissions>',
      '        <editable>true</editable>',
      '        <field>Widget__c.Count__c</field>',
      '        <readable>true</readable>',
      '    </fieldPermissions>',
      '    <userPermissions>',
      '        <enabled>true</enabled>',
      '        <name>ApiEnabled</name>',
      '    </userPermissions>',
      '</Profile>',
      '',
    ].join('\n');
    writeFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), oldProfileXml);

    const orgProfile: ProfileMetadata = {
      fullName: 'Admin',
      classAccesses: [{ apexClass: 'TrackedClass', enabled: 'true' }],
      custom: 'false',
      fieldPermissions: [
        { field: 'Widget__c.Count__c', editable: 'false', readable: 'false' },
        { field: 'Account.Name', editable: 'true', readable: 'true' },
      ],
      userLicense: 'Salesforce',
      userPermissions: [
        { name: 'ApiEnabled', enabled: 'true' },
        { name: 'ViewSetup', enabled: 'true' },
      ],
    };

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });

    assert.deepEqual(result.synced, [
      {
        name: 'Admin',
        path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'),
        changed: true,
        changes: [
          { section: 'classAccesses', added: 0, removed: 0, modified: 1 },
          { section: 'custom', added: 0, removed: 0, modified: 1 },
          { section: 'fieldPermissions', added: 1, removed: 1, modified: 1 },
          { section: 'userLicense', added: 1, removed: 0, modified: 0 },
          { section: 'userPermissions', added: 1, removed: 0, modified: 0 },
        ],
      },
    ]);
  });

  it('reports no changes and does not rewrite the file when the org matches disk', async () => {
    const projectRoot = trackProject(createProject());
    const orgProfile: ProfileMetadata = {
      fullName: 'Admin',
      classAccesses: [{ apexClass: 'TrackedClass', enabled: 'false' }],
      custom: 'false',
      userPermissions: [{ name: 'ApiEnabled', enabled: 'true' }],
    };
    const profilePath = join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml');

    await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });
    const syncedContent = readFileSync(profilePath, 'utf8');
    chmodSync(profilePath, 0o444);

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });

    assert.deepEqual(result.synced, [{ name: 'Admin', path: profilePath, changed: false, changes: [] }]);
    assert.equal(readFileSync(profilePath, 'utf8'), syncedContent);
  });

  it('reports a change with an empty section summary when only formatting differs', async () => {
    const projectRoot = trackProject(createProject());
    const profilePath = join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml');
    writeFileSync(
      profilePath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n  <custom>true</custom>\n</Profile>\n'
    );

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([{ fullName: 'Admin', custom: 'true' }]) });

    assert.deepEqual(result.synced, [{ name: 'Admin', path: profilePath, changed: true, changes: [] }]);
    assert.equal(result.drifted, true);
    assert.equal(readFileSync(profilePath, 'utf8'), staleProfileXml);
  });

  it('reports drift without writing in dry-run mode', async () => {
    const projectRoot = trackProject(createProject());
    const profilePath = join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml');
    chmodSync(profilePath, 0o444);
    const orgProfile: ProfileMetadata = { fullName: 'Admin', custom: 'false' };

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]), dryRun: true });

    assert.deepEqual(result, {
      synced: [
        {
          name: 'Admin',
          path: profilePath,
          changed: true,
          changes: [{ section: 'custom', added: 0, removed: 0, modified: 1 }],
        },
      ],
      skipped: [],
      failed: [],
      dryRun: true,
      drifted: true,
    });
    assert.equal(readFileSync(profilePath, 'utf8'), staleProfileXml);
  });

  it('reports no drift in dry-run mode when the org matches disk', async () => {
    const projectRoot = trackProject(createProject());
    const orgProfile: ProfileMetadata = { fullName: 'Admin', custom: 'true' };
    await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]) });

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([orgProfile]), dryRun: true });

    assert.equal(result.drifted, false);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.synced, [
      {
        name: 'Admin',
        path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'),
        changed: false,
        changes: [],
      },
    ]);
  });

  it('adopts an untracked profile into the default package directory, filtered and canonically serialized', async () => {
    const projectRoot = trackProject(createProject());
    const orgProfile: ProfileMetadata = {
      fullName: 'Read Only',
      classAccesses: [
        { apexClass: 'OrgOnlyClass', enabled: 'true' },
        { apexClass: 'TrackedClass', enabled: 'false' },
      ],
      custom: 'false',
      userLicense: 'Salesforce',
    };

    const result = await syncProfiles({ projectRoot, profileNames: ['Read Only'], readProfiles: readerFor([orgProfile]), adoptUntracked: true });

    const adoptedPath = join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Read Only.profile-meta.xml');
    assert.deepEqual(result, {
      synced: [
        {
          name: 'Read Only',
          path: adoptedPath,
          changed: true,
          adopted: true,
          changes: [
            { section: 'classAccesses', added: 1, removed: 0, modified: 0 },
            { section: 'custom', added: 1, removed: 0, modified: 0 },
            { section: 'userLicense', added: 1, removed: 0, modified: 0 },
          ],
        },
      ],
      skipped: [],
      failed: [],
      dryRun: false,
      drifted: true,
    });

    const expected = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <classAccesses>',
      '        <apexClass>TrackedClass</apexClass>',
      '        <enabled>false</enabled>',
      '    </classAccesses>',
      '    <custom>false</custom>',
      '    <userLicense>Salesforce</userLicense>',
      '</Profile>',
      '',
    ].join('\n');
    assert.equal(readFileSync(adoptedPath, 'utf8'), expected);
  });

  it('adopts a profile byte-identically to a tracked sync of the same payload', async () => {
    const projectRoot = trackProject(createProject());
    const sections: ProfileMetadata = {
      classAccesses: [
        { apexClass: 'OrgOnlyClass', enabled: 'true' },
        { apexClass: 'TrackedClass', enabled: 'false' },
      ],
      custom: 'false',
      fieldPermissions: [
        { field: 'Widget__c.Count__c', editable: 'false', readable: 'false' },
        { field: 'OrgOnly__c.Stuff__c', editable: 'true', readable: 'true' },
      ],
      loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255', description: 'Office' }],
      userLicense: 'Salesforce',
      userPermissions: [{ name: 'ApiEnabled', enabled: 'true' }],
    };

    await syncProfiles({ projectRoot, profileNames: ['Admin'], readProfiles: readerFor([{ ...sections, fullName: 'Admin' }]) });
    await syncProfiles({
      projectRoot,
      profileNames: ['Read Only'],
      readProfiles: readerFor([{ ...sections, fullName: 'Read Only' }]),
      adoptUntracked: true,
    });

    const syncedContent = readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'), 'utf8');
    const adoptedContent = readFileSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Read Only.profile-meta.xml'), 'utf8');
    assert.equal(adoptedContent, syncedContent);
  });

  it('refreshes tracked profiles and adopts untracked ones in a single run', async () => {
    const projectRoot = trackProject(createProject({ profiles: ['Admin'] }));
    const readProfiles = (profileNames: string[]): Promise<ProfileMetadata[]> =>
      Promise.resolve(profileNames.map((name) => ({ fullName: name, custom: 'false' })));

    const result = await syncProfiles({ projectRoot, profileNames: ['Admin', 'Read Only'], readProfiles, adoptUntracked: true });

    assert.deepEqual(result.synced, [
      {
        name: 'Admin',
        path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Admin.profile-meta.xml'),
        changed: true,
        changes: [{ section: 'custom', added: 0, removed: 0, modified: 1 }],
      },
      {
        name: 'Read Only',
        path: join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Read Only.profile-meta.xml'),
        changed: true,
        adopted: true,
        changes: [{ section: 'custom', added: 1, removed: 0, modified: 0 }],
      },
    ]);
    assert.notEqual(readFileSync(result.synced[0].path, 'utf8'), staleProfileXml);
    assert.equal(readFileSync(result.synced[1].path, 'utf8'), readFileSync(result.synced[0].path, 'utf8'));
  });

  it('adopts into the default package directory even when it is not listed first', async () => {
    const projectRoot = trackProject(createProject({ defaultPackageDirectory: 'other-app' }));

    const result = await syncProfiles({
      projectRoot,
      profileNames: ['Read Only'],
      readProfiles: readerFor([{ fullName: 'Read Only', custom: 'false' }]),
      adoptUntracked: true,
    });

    const adoptedPath = join(projectRoot, 'other-app', 'main', 'default', 'profiles', 'Read Only.profile-meta.xml');
    assert.equal(result.synced[0].path, adoptedPath);
    assert.ok(readFileSync(adoptedPath, 'utf8').includes('<custom>false</custom>'));
  });

  it('does not create an adopted profile file in dry-run mode', async () => {
    const projectRoot = trackProject(createProject());

    const result = await syncProfiles({
      projectRoot,
      profileNames: ['Read Only'],
      readProfiles: readerFor([{ fullName: 'Read Only', custom: 'false' }]),
      adoptUntracked: true,
      dryRun: true,
    });

    assert.equal(result.drifted, true);
    assert.deepEqual(
      result.synced.map((profile) => ({ name: profile.name, changed: profile.changed, adopted: profile.adopted })),
      [{ name: 'Read Only', changed: true, adopted: true }]
    );
    assert.equal(existsSync(join(projectRoot, 'force-app', 'main', 'default', 'profiles', 'Read Only.profile-meta.xml')), false);
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

});
