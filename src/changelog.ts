import { execSync } from "child_process";
import ts from "typescript";
import { fileURLToPath } from "url";

export function gitShowFile(commit: string, path: string): string {
  return execSync(`git show ${commit}:${path}`, { encoding: "utf-8" });
}

function gitLatestTag() {
  return execSync(`git describe --tags --abbrev=0`, {
    encoding: "utf-8",
  }).trim();
}

type InterfaceMembers = Map<string, Map<string, string[]>>;

function memberName(member: ts.TypeElement, source: ts.SourceFile) {
  if (ts.isConstructSignatureDeclaration(member)) {
    return "constructor";
  }
  if (ts.isCallSignatureDeclaration(member)) {
    return "call signature";
  }
  if (ts.isIndexSignatureDeclaration(member)) {
    return "index signature";
  }
  const name = member.name?.getText(source);
  if (!name) {
    return undefined;
  }
  return ts.isMethodSignature(member) ? `${name}()` : name;
}

function mapMembers(
  members: ts.NodeArray<ts.TypeElement>,
  source: ts.SourceFile,
): Map<string, string[]> {
  const memberMap = new Map<string, string[]>();
  for (const member of members) {
    const name = memberName(member, source);
    if (!name) {
      continue;
    }
    const signatures = memberMap.get(name) ?? [];
    signatures.push(member.getText(source));
    memberMap.set(name, signatures);
  }
  return memberMap;
}

function mapInterfaceToMembers(
  interfaces: ts.InterfaceDeclaration[],
  source: ts.SourceFile,
): InterfaceMembers {
  const interfaceToMemberMap: InterfaceMembers = new Map();
  for (const decl of interfaces) {
    interfaceToMemberMap.set(decl.name.text, mapMembers(decl.members, source));
  }
  return interfaceToMemberMap;
}

function mapOtherDeclarations(source: ts.SourceFile) {
  const declarations = new Map<string, string[]>();
  const staticMembers: InterfaceMembers = new Map();

  function add(name: string, text: string) {
    const texts = declarations.get(name) ?? [];
    texts.push(text);
    declarations.set(name, texts);
  }

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (declaration.type && ts.isTypeLiteralNode(declaration.type)) {
          staticMembers.set(name, mapMembers(declaration.type.members, source));
        } else {
          add(name, declaration.getText(source));
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(`${statement.name.text}()`, statement.getText(source));
    } else if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      add(statement.name.text, statement.getText(source));
    }
  }

  return { declarations, staticMembers };
}

function extractTypesFromFile(file: string) {
  const source = ts.createSourceFile(
    "dom",
    file,
    ts.ScriptTarget.ES2015,
    /*setParentNodes */ true,
  );

  const interfaceNames = source.statements
    .filter(ts.isVariableStatement)
    .map((v) => v.declarationList.declarations[0].name.getText(source));
  const tsInterfacedecls = source.statements.filter(ts.isInterfaceDeclaration);
  const idlInterfaceDecls = tsInterfacedecls.filter((i) =>
    interfaceNames.includes(i.name.text),
  );
  const otherDecls = tsInterfacedecls.filter(
    (i) => !interfaceNames.includes(i.name.text),
  );

  const interfaceToMemberMap = mapInterfaceToMembers(idlInterfaceDecls, source);
  const otherToMemberMap = mapInterfaceToMembers(otherDecls, source);
  const { declarations, staticMembers } = mapOtherDeclarations(source);

  return {
    interfaceToMemberMap,
    otherToMemberMap,
    staticMembers,
    declarations,
  };
}

function compareSet<T>(x: Set<T>, y: Set<T>) {
  function intersection<T>(x: Set<T>, y: Set<T>) {
    const result = new Set<T>();
    for (const i of y) {
      if (x.has(i)) {
        result.add(i);
      }
    }
    return result;
  }
  function difference<T>(x: Set<T>, y: Set<T>) {
    const result = new Set(x);
    for (const i of y) {
      result.delete(i);
    }
    return result;
  }
  const common = intersection(x, y);
  const added = difference(y, common);
  const removed = difference(x, common);
  return { added, removed, common };
}

function diffTypes(previous: string, current: string) {
  function diff(previousMap: InterfaceMembers, currentMap: InterfaceMembers) {
    const { added, removed, common } = compareSet(
      new Set(previousMap.keys()),
      new Set(currentMap.keys()),
    );
    const modified = new Map<
      string,
      { added: Set<string>; removed: Set<string>; changed: Set<string> }
    >();
    for (const name of common) {
      const previousMemberMap = previousMap.get(name)!;
      const currentMemberMap = currentMap.get(name)!;
      const previousMembers = new Set(previousMemberMap.keys());
      const currentMembers = new Set(currentMemberMap.keys());
      const { added, removed } = compareSet(previousMembers, currentMembers);
      const changed = new Set<string>();
      for (const memberName of compareSet(previousMembers, currentMembers)
        .common) {
        const previousSignatures = new Set(previousMemberMap.get(memberName)!);
        const currentSignatures = new Set(currentMemberMap.get(memberName)!);
        const signatureDiff = compareSet(previousSignatures, currentSignatures);
        if (signatureDiff.added.size || signatureDiff.removed.size) {
          changed.add(memberName);
        }
      }
      if (!added.size && !removed.size && !changed.size) {
        continue;
      }
      modified.set(name, { added, removed, changed });
    }
    return { added, removed, modified };
  }

  const previousTypes = extractTypesFromFile(previous);
  const currentTypes = extractTypesFromFile(current);
  const declarationNames = compareSet(
    new Set(previousTypes.declarations.keys()),
    new Set(currentTypes.declarations.keys()),
  );
  const changedDeclarations = new Set<string>();
  for (const name of declarationNames.common) {
    const previousDeclarations = new Set(previousTypes.declarations.get(name)!);
    const currentDeclarations = new Set(currentTypes.declarations.get(name)!);
    const declarationDiff = compareSet(
      previousDeclarations,
      currentDeclarations,
    );
    if (declarationDiff.added.size || declarationDiff.removed.size) {
      changedDeclarations.add(name);
    }
  }

  return {
    interfaces: diff(
      previousTypes.interfaceToMemberMap,
      currentTypes.interfaceToMemberMap,
    ),
    others: diff(previousTypes.otherToMemberMap, currentTypes.otherToMemberMap),
    statics: diff(previousTypes.staticMembers, currentTypes.staticMembers),
    declarations: {
      added: declarationNames.added,
      removed: declarationNames.removed,
      changed: changedDeclarations,
    },
  };
}

function writeAddedRemoved(added: Set<string>, removed: Set<string>) {
  function newlineSeparatedList(names: Set<string>) {
    return [...names].map((a) => `* \`${a}\``).join("\n");
  }
  const output = [];
  if (added.size) {
    output.push(`## New interfaces\n\n${newlineSeparatedList(added)}`);
  }
  if (removed.size) {
    output.push(`## Removed interfaces\n\n${newlineSeparatedList(removed)}`);
  }
  return output.join("\n\n");
}

function writeMemberChanges(added: Set<string>, removed: Set<string>) {
  function commaSeparatedList(names: Set<string>) {
    return [...names].map((a) => `\`${a}\``).join(", ");
  }
  const output = [];
  if (added.size) {
    output.push(`  * Added: ${commaSeparatedList(added)}`);
  }
  if (removed.size) {
    output.push(`  * Removed: ${commaSeparatedList(removed)}`);
  }
  return output.join("\n");
}

function writeDeclarationChanges(added: Set<string>, removed: Set<string>) {
  const output = [];
  if (added.size) {
    output.push(`* Added: ${[...added].map((a) => `\`${a}\``).join(", ")}`);
  }
  if (removed.size) {
    output.push(`* Removed: ${[...removed].map((a) => `\`${a}\``).join(", ")}`);
  }
  return output.join("\n");
}

function writeChangedSignatures(
  modifiedGroups: Map<
    string,
    { added: Set<string>; removed: Set<string>; changed: Set<string> }
  >[],
  changedDeclarations: Set<string>,
) {
  function join(items: string[]) {
    if (items.length < 2) {
      return items[0];
    }
    if (items.length === 2) {
      return `${items[0]} and ${items[1]}`;
    }
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  const output = [];
  for (const modified of modifiedGroups) {
    for (const [name, { changed }] of modified) {
      if (!changed.size) {
        continue;
      }
      const signatures = [...changed].map((member) => {
        if (member === "constructor") {
          return `\`${name}\` constructor`;
        }
        if (member === "call signature" || member === "index signature") {
          return `\`${name}\` ${member}`;
        }
        return `\`${name}.${member}\``;
      });
      output.push(`* ${join(signatures)}`);
    }
  }
  for (const name of changedDeclarations) {
    output.push(`* \`${name}\``);
  }
  return output.join("\n");
}

const dom = "baselines/dom.generated.d.ts";

export function generateDefaultFromRecentTag(): string {
  const [base = gitLatestTag(), head = "HEAD"] = process.argv.slice(2);
  const previous = gitShowFile(base, dom);
  const current = gitShowFile(head, dom);
  const changelog = generateChangelogFrom(previous, current);
  if (!changelog.length) {
    throw new Error(`No change reported between ${base} and ${head}.`);
  }
  return changelog;
}

export function generateChangelogFrom(
  previous: string,
  current: string,
): string {
  const {
    interfaces: { added, removed, modified },
    others,
    statics,
    declarations,
  } = diffTypes(previous, current);

  const outputs = [];
  if (added.size || removed.size) {
    outputs.push(writeAddedRemoved(added, removed));
  }

  const memberGroups = [modified, others.modified, statics.modified];
  if (
    memberGroups.some((group) =>
      [...group.values()].some(
        ({ added, removed }) => added.size || removed.size,
      ),
    )
  ) {
    const modifiedOutput = [`## Modified\n`];
    for (const group of memberGroups) {
      for (const [key, value] of group) {
        if (!value.added.size && !value.removed.size) {
          continue;
        }
        modifiedOutput.push(`* ${key}`);
        modifiedOutput.push(writeMemberChanges(value.added, value.removed));
      }
    }
    outputs.push(modifiedOutput.join("\n"));
  }

  const changedSignatures = writeChangedSignatures(
    memberGroups,
    declarations.changed,
  );
  if (changedSignatures) {
    outputs.push(`## Changed signatures\n\n${changedSignatures}`);
  }

  const otherAdded = new Set([...others.added, ...declarations.added]);
  const otherRemoved = new Set([...others.removed, ...declarations.removed]);
  if (otherAdded.size || otherRemoved.size) {
    outputs.push(
      `## Other declarations\n\n${writeDeclarationChanges(
        otherAdded,
        otherRemoved,
      )}`,
    );
  }

  if (!outputs.length && previous !== current) {
    outputs.push("## Other changes\n\n* Declaration text changed.");
  }

  const output = outputs.join("\n\n");
  return output;
}

export function formatChangelogEntries(
  entries: readonly { group?: string; notes: string }[],
): string {
  const allGroups = new Set(entries.map(({ group }) => group));
  const groupsByNotes = new Map<string, Set<string | undefined>>();
  for (const { group, notes } of entries) {
    const trimmedNotes = notes.trim();
    if (!trimmedNotes) {
      continue;
    }
    const groups = groupsByNotes.get(trimmedNotes) ?? new Set();
    groups.add(group);
    groupsByNotes.set(trimmedNotes, groups);
  }

  const versionGroups = [...allGroups]
    .filter((group): group is string => group !== undefined)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

  function groupLabel(group: string | undefined) {
    if (!group) {
      const latestVersion = versionGroups[versionGroups.length - 1]?.slice(2);
      return latestVersion
        ? `TypeScript >${latestVersion}`
        : "default TypeScript declarations";
    }
    const version = group.slice(2);
    const index = versionGroups.indexOf(group);
    const previousVersion = versionGroups[index - 1]?.slice(2);
    return previousVersion
      ? `TypeScript >${previousVersion} and <=${version}`
      : `TypeScript <=${version}`;
  }

  return [...groupsByNotes]
    .map(([notes, groups]) => {
      if (
        groups.size === allGroups.size &&
        [...groups].every((group) => allGroups.has(group))
      ) {
        return notes;
      }
      const labels = [...groups].map(groupLabel);
      return `_${labels.join(", ")} only_\n\n${notes}`;
    })
    .join("\n\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(generateDefaultFromRecentTag());
}
