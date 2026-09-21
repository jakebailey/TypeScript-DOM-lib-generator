// @ts-check

// npm run ts-changelog @types/web 0.0.1 0.0.3

import {
  formatChangelogEntries,
  generateChangelogChanges,
  gitShowFile,
} from "../src/changelog.ts";
import { packages } from "./createTypesPackages.js";

const [name, before, to] = process.argv.slice(2);
if (!name || !before || !to) {
  throw new Error(
    "Expected three arguments: package name, version before, version to",
  );
}

const go = () => {
  // We'll need to map back from the filename in the npm package to the
  // generated file in baselines inside the git tag
  const thisPackageMeta = packages.find((p) => p.name === name);
  if (!thisPackageMeta) {
    throw new Error(`Could not find ${name} in ${packages.map((p) => p.name)}`);
  }

  const changelogGroups = new Map();
  for (const file of thisPackageMeta.files) {
    const generatedPrefix = "../generated/";
    if (!file.from.startsWith(generatedPrefix)) {
      throw new Error(`Expected generated file path, got ${file.from}`);
    }
    const filename = `baselines/${file.from.slice(generatedPrefix.length)}`;
    const beforeFileText = gitShowFile(`${name}@${before}`, filename);
    const toFileText = gitShowFile(`${name}@${to}`, filename);

    let changelogGroup = changelogGroups.get(file.group);
    if (!changelogGroup) {
      changelogGroups.set(
        file.group,
        (changelogGroup = { previous: [], current: [] }),
      );
    }
    changelogGroup.previous.push(beforeFileText);
    changelogGroup.current.push(toFileText);
  }
  console.log(
    formatChangelogEntries(
      [...changelogGroups].map(([group, { previous, current }]) => ({
        group,
        changes: generateChangelogChanges(
          previous.join("\n"),
          current.join("\n"),
        ),
      })),
    ),
  );
};

go();
