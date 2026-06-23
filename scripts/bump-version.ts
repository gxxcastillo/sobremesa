#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';

type BumpType = 'major' | 'minor' | 'patch';

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage: bun scripts/bump-version.ts <package-path> <major|minor|patch>',
    );
    process.exit(1);
  }

  const [packagePath, bumpType] = args;

  if (!['major', 'minor', 'patch'].includes(bumpType)) {
    console.error(
      `Error: Invalid bump type "${bumpType}". Use major, minor, or patch.`,
    );
    process.exit(1);
  }

  const pkgJsonPath = path.resolve(packagePath, 'package.json');

  if (!fs.existsSync(pkgJsonPath)) {
    console.error(`Error: package.json not found at ${pkgJsonPath}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const currentVersion = pkg.version;
  const newVersion = semver.inc(currentVersion, bumpType as BumpType);

  if (!newVersion) {
    console.error(`Error: Failed to bump version ${currentVersion}`);
    process.exit(1);
  }

  pkg.version = newVersion;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

  console.log(
    `${path.basename(packagePath)}: ${currentVersion} → ${newVersion}`,
  );
}

main();
