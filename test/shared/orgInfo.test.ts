import assert from 'node:assert/strict';
import {
  buildLicenseRows,
  buildLimitRows,
  formatLimitValue,
  formatMaintenanceWindow,
  formatStorage,
  highestApiVersion,
  myDomainFromInstanceUrl,
  parseTrustStatus,
  trustStatusUrl,
} from '../../src/shared/orgInfo.js';

describe('org info', () => {
  describe('myDomainFromInstanceUrl', () => {
    it('takes the host of the instance URL', () => {
      assert.equal(
        myDomainFromInstanceUrl('https://tomcarman-dev-ed.my.salesforce.com'),
        'tomcarman-dev-ed.my.salesforce.com'
      );
    });

    it('returns the input unchanged when it is not a URL', () => {
      assert.equal(myDomainFromInstanceUrl('not a url'), 'not a url');
    });
  });

  describe('highestApiVersion', () => {
    it('picks the numerically highest version, not the last listed', () => {
      assert.equal(highestApiVersion([{ version: '9.0' }, { version: '67.0' }, { version: '58.0' }]), '67.0');
    });

    it('copes with an empty list', () => {
      assert.equal(highestApiVersion([]), '0.0');
    });
  });

  describe('buildLimitRows', () => {
    const limits = {
      DataStorageMB: { Max: 5, Remaining: 4 },
      FileStorageMB: { Max: 20, Remaining: 20 },
      DailyApiRequests: { Max: 15_000, Remaining: 14_499 },
      SomethingElse: { Max: 1, Remaining: 0 },
    };

    it('derives used from max minus remaining', () => {
      const rows = buildLimitRows(limits);

      assert.deepEqual(
        rows.map((row) => [row.key, row.used, row.max]),
        [
          ['DataStorageMB', 1, 5],
          ['FileStorageMB', 0, 20],
          ['DailyApiRequests', 501, 15_000],
        ]
      );
    });

    it('reports the percentage used to one decimal place', () => {
      assert.equal(buildLimitRows(limits)[2].percent, 3.3);
      assert.equal(buildLimitRows(limits)[0].percent, 20);
    });

    it('reports only the three limits the card shows', () => {
      assert.equal(
        buildLimitRows(limits).some((row) => row.key === 'SomethingElse'),
        false
      );
    });

    it('skips a limit the org does not report', () => {
      assert.deepEqual(buildLimitRows({ DataStorageMB: undefined }), []);
      assert.deepEqual(buildLimitRows({}), []);
    });

    it('does not divide by zero on a zero maximum', () => {
      assert.equal(buildLimitRows({ DataStorageMB: { Max: 0, Remaining: 0 } })[0].percent, 0);
    });

    it('never reports negative usage when remaining exceeds max', () => {
      assert.equal(buildLimitRows({ DataStorageMB: { Max: 5, Remaining: 9 } })[0].used, 0);
    });
  });

  describe('formatStorage', () => {
    it('shows megabytes below a gigabyte and gigabytes above', () => {
      assert.equal(formatStorage(512), '512 MB');
      assert.equal(formatStorage(1024), '1.0 GB');
      assert.equal(formatStorage(2560), '2.5 GB');
    });
  });

  describe('formatLimitValue', () => {
    it('formats storage as storage and counts with thousand separators', () => {
      assert.equal(formatLimitValue(2048, 'MB'), '2.0 GB');
      assert.equal(formatLimitValue(15_000, 'count'), '15,000');
    });
  });

  describe('buildLicenseRows', () => {
    const records = [
      { Name: 'Chatter Free', UsedLicenses: 1, TotalLicenses: 5000 },
      { Name: 'Salesforce', UsedLicenses: 2, TotalLicenses: 2 },
      { Name: 'Unused', UsedLicenses: 0, TotalLicenses: 10 },
      { Name: 'Analytics', UsedLicenses: null, TotalLicenses: null },
    ];

    it('lists the busiest licenses first and drops the unused ones', () => {
      assert.deepEqual(buildLicenseRows(records, 5), [
        { name: 'Salesforce', used: 2, total: 2 },
        { name: 'Chatter Free', used: 1, total: 5000 },
      ]);
    });

    it('keeps the list short', () => {
      assert.equal(buildLicenseRows(records, 1).length, 1);
    });

    it('breaks ties alphabetically', () => {
      const rows = buildLicenseRows(
        [
          { Name: 'Zeta', UsedLicenses: 1, TotalLicenses: 1 },
          { Name: 'Alpha', UsedLicenses: 1, TotalLicenses: 1 },
        ],
        5
      );

      assert.deepEqual(
        rows.map((row) => row.name),
        ['Alpha', 'Zeta']
      );
    });
  });

  describe('trustStatusUrl', () => {
    it('points at the instance status endpoint', () => {
      assert.equal(trustStatusUrl('USA838'), 'https://api.status.salesforce.com/v1/instances/USA838/status');
    });
  });

  describe('parseTrustStatus', () => {
    const now = new Date('2026-07-29T00:00:00.000Z');

    const response = {
      releaseVersion: "Summer '26 Patch 12.10",
      releaseNumber: '262.12.10',
      Maintenances: [
        {
          name: 'Past window',
          plannedStartTime: '2026-06-01T04:00:00.000Z',
          plannedEndTime: '2026-06-01T05:00:00.000Z',
        },
        {
          name: "Winter '27",
          plannedStartTime: '2026-10-10T04:00:00.000Z',
          plannedEndTime: '2026-10-10T04:30:00.000Z',
        },
        {
          name: 'IP list update',
          plannedStartTime: '2026-08-08T22:13:00.000Z',
          plannedEndTime: '2026-08-08T22:13:00.000Z',
        },
      ],
    };

    it('carries the release version and number through', () => {
      const release = parseTrustStatus(response, now);

      assert.equal(release.available, true);
      assert.equal(release.available && release.releaseVersion, "Summer '26 Patch 12.10");
      assert.equal(release.available && release.releaseNumber, '262.12.10');
    });

    it('drops finished windows and orders the rest soonest first', () => {
      const release = parseTrustStatus(response, now);

      assert.deepEqual(release.available ? release.maintenances.map((window) => window.name) : [], [
        'IP list update',
        "Winter '27",
      ]);
    });

    it('keeps the list short', () => {
      const release = parseTrustStatus(response, now, 1);

      assert.equal(release.available && release.maintenances.length, 1);
    });

    it('copes with a response carrying no maintenance or version data', () => {
      const release = parseTrustStatus({}, now);

      assert.deepEqual(release, { available: true, releaseVersion: '', releaseNumber: '', maintenances: [] });
    });

    it('ignores entries with no planned times', () => {
      const release = parseTrustStatus({ Maintenances: [{ name: 'Vague' }] }, now);

      assert.deepEqual(release.available ? release.maintenances : ['unexpected'], []);
    });
  });

  describe('formatMaintenanceWindow', () => {
    it('shows only the end time when the window is within one day', () => {
      assert.equal(
        formatMaintenanceWindow({
          name: 'x',
          start: '2026-10-10T04:00:00.000Z',
          end: '2026-10-10T04:30:00.000Z',
        }).includes(' to '),
        true
      );
      assert.equal(
        formatMaintenanceWindow({
          name: 'x',
          start: '2026-10-10T04:00:00.000Z',
          end: '2026-10-10T04:30:00.000Z',
        }).split(' to ')[1].length,
        5
      );
    });

    it('shows the end date too when the window spans days', () => {
      const rendered = formatMaintenanceWindow({
        name: 'x',
        start: '2026-10-10T04:00:00.000Z',
        end: '2026-10-12T04:00:00.000Z',
      });

      assert.equal(rendered.split(' to ')[1].startsWith('2026-10-12'), true);
    });
  });
});
