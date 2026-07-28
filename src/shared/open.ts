import { spawn } from 'node:child_process';

/**
 * What `raven open` decided the user meant, and where to send the browser.
 * `path` is relative to the org's instance URL and is handed to
 * `Org.getFrontDoorUrl` to be turned into a single-use frontdoor URL.
 */
export type OpenTarget = {
  kind: OpenTargetKind;
  /** What was matched, for the "opening X" message. */
  name: string;
  path: string;
};

export type OpenTargetKind = 'record';

const recordIdPattern = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export const isRecordId = (thing: string): boolean => recordIdPattern.test(thing);

/**
 * Records are opened by bare Id: Salesforce redirects `/<id>` to whichever view
 * is right for that object, so no describe round-trip is needed and tooling
 * objects work too.
 */
export const buildRecordTarget = (id: string): OpenTarget => ({ kind: 'record', name: id, path: `/${id}` });

type OpenerCommand = { command: string; args: string[] };

export const openerCommand = (platform: NodeJS.Platform, url: string): OpenerCommand => {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // The empty string is `start`'s title argument; without it a quoted URL is
      // treated as the window title and nothing opens.
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
};

export const launchBrowser = async (url: string, platform: NodeJS.Platform = process.platform): Promise<void> => {
  const { command, args } = openerCommand(platform, url);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
};
