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

type AtomKind = "interface" | "declaration" | "member";

interface ApiAtom {
  key: string;
  kind: AtomKind;
  label: string;
  parent?: string;
  container?: boolean;
  staticContainer?: boolean;
  signatures: string[];
}

interface ApiModel {
  atoms: Map<string, ApiAtom>;
  unhandled: string[];
}

export type ChangelogChangeKind =
  | "interface-added"
  | "interface-removed"
  | "member-added"
  | "member-removed"
  | "signature-changed"
  | "declaration-added"
  | "declaration-removed"
  | "other-changed";

export interface ChangelogChange {
  key: string;
  kind: ChangelogChangeKind;
  label: string;
}

export interface ChangelogEntry {
  group?: string;
  changes: readonly ChangelogChange[];
}

function qualifiedName(prefix: string | undefined, name: string) {
  return prefix ? `${prefix}.${name}` : name;
}

function quoted(name: string) {
  return `\`${name}\``;
}

function memberIdentity(member: ts.TypeElement, source: ts.SourceFile) {
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

function memberLabel(parent: string, member: string) {
  if (member === "constructor") {
    return `${quoted(parent)} constructor`;
  }
  if (member === "call signature" || member === "index signature") {
    return `${quoted(parent)} ${member}`;
  }
  return quoted(`${parent}.${member}`);
}

function interfaceHeader(
  declaration: ts.InterfaceDeclaration,
  source: ts.SourceFile,
) {
  const modifiers = declaration.modifiers
    ?.map((modifier) => modifier.getText(source))
    .join(" ");
  const typeParameters = declaration.typeParameters
    ? `<${declaration.typeParameters
        .map((parameter) => parameter.getText(source))
        .join(", ")}>`
    : "";
  const heritage = declaration.heritageClauses
    ?.map((clause) => clause.getText(source))
    .join(" ");
  return [
    modifiers,
    `interface ${declaration.name.text}${typeParameters}`,
    heritage,
  ]
    .filter(Boolean)
    .join(" ");
}

function declarationListKind(list: ts.VariableDeclarationList) {
  if (list.flags & ts.NodeFlags.Const) {
    return "const";
  }
  if (list.flags & ts.NodeFlags.Let) {
    return "let";
  }
  return "var";
}

function buildApiModel(file: string): ApiModel {
  const source = ts.createSourceFile(
    "dom",
    file,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const atoms = new Map<string, ApiAtom>();
  const unhandled: string[] = [];

  function addAtom(atom: Omit<ApiAtom, "signatures">, signature: string) {
    const existing = atoms.get(atom.key);
    if (existing) {
      existing.signatures.push(signature);
      return;
    }
    atoms.set(atom.key, { ...atom, signatures: [signature] });
  }

  function addMembers(
    parent: string,
    members: ts.NodeArray<ts.TypeElement>,
    source: ts.SourceFile,
    containerKey: string,
  ) {
    for (const member of members) {
      const identity = memberIdentity(member, source);
      if (!identity) {
        unhandled.push(member.getText(source));
        continue;
      }
      addAtom(
        {
          key: `member:${containerKey}:${identity}`,
          kind: "member",
          label: memberLabel(parent, identity),
          parent,
        },
        member.getText(source),
      );
    }
  }

  function visitStatements(
    statements: ts.NodeArray<ts.Statement>,
    prefix?: string,
  ) {
    for (const statement of statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        const name = qualifiedName(prefix, statement.name.text);
        addAtom(
          {
            key: `interface:${name}`,
            kind: "interface",
            label: quoted(name),
            parent: name,
            container: true,
          },
          interfaceHeader(statement, source),
        );
        addMembers(name, statement.members, source, `interface:${name}`);
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const name = qualifiedName(prefix, declaration.name.getText(source));
          if (declaration.type && ts.isTypeLiteralNode(declaration.type)) {
            addAtom(
              {
                key: `variable:${name}`,
                kind: "declaration",
                label: quoted(name),
                parent: name,
                container: true,
                staticContainer: true,
              },
              `${declarationListKind(statement.declarationList)} type literal`,
            );
            addMembers(
              name,
              declaration.type.members,
              source,
              `variable:${name}`,
            );
          } else {
            addAtom(
              {
                key: `variable:${name}`,
                kind: "declaration",
                label: quoted(name),
              },
              `${declarationListKind(statement.declarationList)} ${declaration.getText(source)}`,
            );
          }
        }
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const name = qualifiedName(prefix, `${statement.name.text}()`);
        addAtom(
          {
            key: `function:${name}`,
            kind: "declaration",
            label: quoted(name),
          },
          statement.getText(source),
        );
        continue;
      }

      if (
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        if (!statement.name) {
          unhandled.push(statement.getText(source));
          continue;
        }
        const name = qualifiedName(prefix, statement.name.text);
        addAtom(
          {
            key: `${ts.SyntaxKind[statement.kind]}:${name}`,
            kind: "declaration",
            label: quoted(name),
          },
          statement.getText(source),
        );
        continue;
      }

      if (ts.isModuleDeclaration(statement)) {
        const moduleName = qualifiedName(
          prefix,
          statement.name.getText(source).replace(/^["']|["']$/g, ""),
        );
        addAtom(
          {
            key: `module:${moduleName}`,
            kind: "declaration",
            label: quoted(moduleName),
            parent: moduleName,
            container: true,
          },
          `namespace ${moduleName}`,
        );
        let body = statement.body;
        let bodyPrefix = moduleName;
        while (body && ts.isModuleDeclaration(body)) {
          const nestedName = qualifiedName(
            bodyPrefix,
            body.name.getText(source).replace(/^["']|["']$/g, ""),
          );
          addAtom(
            {
              key: `module:${nestedName}`,
              kind: "declaration",
              label: quoted(nestedName),
              parent: nestedName,
              container: true,
            },
            `namespace ${nestedName}`,
          );
          bodyPrefix = nestedName;
          body = body.body;
        }
        if (body && ts.isModuleBlock(body)) {
          visitStatements(body.statements, bodyPrefix);
        } else if (body) {
          unhandled.push(body.getText(source));
        }
        continue;
      }

      if (
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        ts.isEmptyStatement(statement)
      ) {
        addAtom(
          {
            key: `statement:${statement.kind}:${statement.getText(source)}`,
            kind: "declaration",
            label: quoted(ts.SyntaxKind[statement.kind]),
          },
          statement.getText(source),
        );
        continue;
      }

      unhandled.push(statement.getText(source));
    }
  }

  visitStatements(source.statements);
  return { atoms, unhandled };
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function generateChangelogChanges(
  previous: string,
  current: string,
): ChangelogChange[] {
  const previousModel = buildApiModel(previous);
  const currentModel = buildApiModel(current);
  const addedAtoms = [...currentModel.atoms.values()].filter(
    ({ key }) => !previousModel.atoms.has(key),
  );
  const removedAtoms = [...previousModel.atoms.values()].filter(
    ({ key }) => !currentModel.atoms.has(key),
  );
  const addedContainers = new Set(
    addedAtoms.filter(({ container }) => container).map(({ parent }) => parent),
  );
  const removedContainers = new Set(
    removedAtoms
      .filter(({ container }) => container)
      .map(({ parent }) => parent),
  );
  const addedInterfaces = new Set(
    addedAtoms
      .filter(({ kind }) => kind === "interface")
      .map(({ parent }) => parent),
  );
  const removedInterfaces = new Set(
    removedAtoms
      .filter(({ kind }) => kind === "interface")
      .map(({ parent }) => parent),
  );
  const changes: ChangelogChange[] = [];

  function addExistenceChange(atom: ApiAtom, direction: "added" | "removed") {
    if (atom.kind === "member") {
      const containers =
        direction === "added" ? addedContainers : removedContainers;
      if (atom.parent && containers.has(atom.parent)) {
        return;
      }
      changes.push({
        key: atom.key,
        kind: direction === "added" ? "member-added" : "member-removed",
        label: atom.label,
      });
      return;
    }
    if (atom.kind === "interface") {
      changes.push({
        key: atom.key,
        kind: direction === "added" ? "interface-added" : "interface-removed",
        label: atom.label,
      });
      return;
    }
    const companionInterfaces =
      direction === "added" ? addedInterfaces : removedInterfaces;
    if (
      atom.staticContainer &&
      atom.parent &&
      companionInterfaces.has(atom.parent)
    ) {
      return;
    }
    changes.push({
      key: atom.key,
      kind: direction === "added" ? "declaration-added" : "declaration-removed",
      label: atom.label,
    });
  }

  for (const atom of addedAtoms) {
    addExistenceChange(atom, "added");
  }
  for (const atom of removedAtoms) {
    addExistenceChange(atom, "removed");
  }

  for (const [key, previousAtom] of previousModel.atoms) {
    const currentAtom = currentModel.atoms.get(key);
    if (
      currentAtom &&
      !arraysEqual(previousAtom.signatures, currentAtom.signatures)
    ) {
      changes.push({
        key,
        kind: "signature-changed",
        label: currentAtom.label,
      });
    }
  }

  if (
    !arraysEqual(previousModel.unhandled, currentModel.unhandled) ||
    (!changes.length && previous !== current)
  ) {
    changes.push({
      key: "other",
      kind: "other-changed",
      label: "Declaration text changed.",
    });
  }

  return changes;
}

const sectionTitles: Record<ChangelogChangeKind, string> = {
  "interface-added": "New interfaces",
  "interface-removed": "Removed interfaces",
  "member-added": "Added members",
  "member-removed": "Removed members",
  "signature-changed": "Changed signatures",
  "declaration-added": "Added declarations",
  "declaration-removed": "Removed declarations",
  "other-changed": "Other changes",
};

const sectionOrder = Object.keys(sectionTitles) as ChangelogChangeKind[];

function versionGroupLabels(groups: Set<string | undefined>) {
  const versionGroups = [...groups]
    .filter((group): group is string => group !== undefined)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

  return {
    label(group: string | undefined) {
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
    },
  };
}

export function formatChangelogEntries(entries: readonly ChangelogEntry[]) {
  const allGroups = new Set(entries.map(({ group }) => group));
  const labels = versionGroupLabels(allGroups);
  const aggregated = new Map<
    string,
    { change: ChangelogChange; groups: Set<string | undefined> }
  >();

  for (const { group, changes } of entries) {
    for (const change of changes) {
      const identity = `${change.kind}:${change.key}`;
      const existing = aggregated.get(identity);
      if (existing) {
        existing.groups.add(group);
      } else {
        aggregated.set(identity, { change, groups: new Set([group]) });
      }
    }
  }

  const sections = [];
  for (const kind of sectionOrder) {
    const sectionChanges = [...aggregated.values()].filter(
      ({ change }) => change.kind === kind,
    );
    if (!sectionChanges.length) {
      continue;
    }
    const lines = sectionChanges.map(({ change, groups }) => {
      const appliesToAll =
        groups.size === allGroups.size &&
        [...groups].every((group) => allGroups.has(group));
      const scope = appliesToAll
        ? ""
        : ` _(${[...groups].map(labels.label).join(", ")} only)_`;
      return `* ${change.label}${scope}`;
    });
    sections.push(`## ${sectionTitles[kind]}\n\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

export function generateChangelogFrom(
  previous: string,
  current: string,
): string {
  return formatChangelogEntries([
    { changes: generateChangelogChanges(previous, current) },
  ]);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(generateDefaultFromRecentTag());
}
