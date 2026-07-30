import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson;

describe('package metadata', () => {
  it('uses the renamed npm package', () => {
    assert.equal(packageJson.name, 'sf-raven-cli');
  });

  it('keeps Git-hook tooling out of production dependencies', () => {
    assert.equal(packageJson.dependencies?.husky, undefined);
    assert.equal(packageJson.dependencies?.pinst, undefined);
    assert.ok(packageJson.devDependencies?.husky);
    assert.ok(packageJson.devDependencies?.pinst);
  });
});
