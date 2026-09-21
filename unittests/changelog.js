import assert from "node:assert/strict";
import {
  formatChangelogEntries,
  generateChangelogChanges,
  generateChangelogFrom,
} from "../src/changelog.ts";

function assertChangelog(previous, current, expected) {
  assert.equal(generateChangelogFrom(previous, current), expected);
}

assertChangelog(
  `
interface Request {}
declare var Request: {
    prototype: Request;
    new(input: RequestInfo | URL): Request;
};
interface URL {}
declare var URL: {
    prototype: URL;
    new(url: string | URL): URL;
    canParse(url: string | URL): boolean;
};
interface WindowOrWorkerGlobalScope {
    fetch(input: RequestInfo | URL): Promise<Response>;
}
interface XMLHttpRequest {
    open(method: string, url: string | URL): void;
}
declare function fetch(input: RequestInfo | URL): Promise<Response>;
`,
  `
interface Request {}
declare var Request: {
    prototype: Request;
    new(input: RequestInfo | WorkerLocation | URL): Request;
};
interface URL {}
declare var URL: {
    prototype: URL;
    new(url: string | WorkerLocation | URL): URL;
    canParse(url: string | WorkerLocation | URL): boolean;
};
interface WindowOrWorkerGlobalScope {
    fetch(input: RequestInfo | WorkerLocation | URL): Promise<Response>;
}
interface XMLHttpRequest {
    open(method: string, url: string | WorkerLocation | URL): void;
}
declare function fetch(input: RequestInfo | WorkerLocation | URL): Promise<Response>;
`,
  `## Changed signatures

* \`Request\` constructor
* \`URL\` constructor
* \`URL.canParse()\`
* \`WindowOrWorkerGlobalScope.fetch()\`
* \`XMLHttpRequest.open()\`
* \`fetch()\``,
);

assertChangelog(
  `
interface Headers {
    get(name: string): string | null;
}
interface Headers {
    entries(): Iterator<string>;
}
`,
  `
interface Headers {
    get(name: string): string | undefined;
}
interface Headers {
    entries(): Iterator<string>;
}
`,
  `## Changed signatures

* \`Headers.get()\``,
);

assertChangelog(
  `
declare namespace CSS {
    function supports(value: string): boolean;
}
`,
  `
declare namespace CSS {
    function supports(value: string | number): boolean;
}
`,
  `## Changed signatures

* \`CSS.supports()\``,
);

assertChangelog(
  "interface Child<T = string> extends Parent {}",
  "interface Child<T = number> {}",
  `## Changed signatures

* \`Child\``,
);

assertChangelog(
  `
interface Example {
    f(value: string): string;
    f(value: string): number;
}
`,
  `
interface Example {
    f(value: string): number;
    f(value: string): string;
}
`,
  `## Changed signatures

* \`Example.f()\``,
);

assertChangelog(
  "declare var Audio: { new(): Audio; };",
  "",
  `## Removed declarations

* \`Audio\``,
);

assertChangelog(
  `
interface Example {
    oldValue: string;
    stable: string;
}
type OldType = string;
`,
  `
interface Example {
    newMethod(): void;
    stable: number;
}
type NewType = string;
`,
  `## Added members

* \`Example.newMethod()\`

## Removed members

* \`Example.oldValue\`

## Changed signatures

* \`Example.stable\`

## Added declarations

* \`NewType\`

## Removed declarations

* \`OldType\``,
);

assertChangelog(
  "declare var Alias: { new(): Target; };",
  "declare var Alias: AliasConstructor;",
  `## Removed members

* \`Alias\` constructor

## Changed signatures

* \`Alias\``,
);

assertChangelog(
  "interface Example { value: string; }",
  "/** Documentation. */\ninterface Example { value: string; }",
  `## Other changes

* Declaration text changed.`,
);

const movedDeclarationBefore = [
  "interface Headers {}",
  "interface Headers { entries(): Iterator<string>; }",
].join("\n");
const movedDeclarationAfter = [
  "interface Headers { entries(): Iterator<string>; }",
  "interface Headers {}",
].join("\n");
assert.deepEqual(
  generateChangelogChanges(movedDeclarationBefore, movedDeclarationAfter),
  [
    {
      key: "other",
      kind: "other-changed",
      label: "Declaration text changed.",
    },
  ],
);

const allVariantsPrevious = "interface Example { x: string; y: string; }";
const defaultCurrent = "interface Example { x: number; y: number; }";
const compatibilityCurrent = "interface Example { x: number; y: string; }";
assert.equal(
  formatChangelogEntries([
    {
      changes: generateChangelogChanges(allVariantsPrevious, defaultCurrent),
    },
    {
      group: "ts5.5",
      changes: generateChangelogChanges(
        allVariantsPrevious,
        compatibilityCurrent,
      ),
    },
    {
      group: "ts5.6",
      changes: generateChangelogChanges(
        allVariantsPrevious,
        compatibilityCurrent,
      ),
    },
  ]),
  `## Changed signatures

* \`Example.x\`
* \`Example.y\` _(TypeScript >5.6 only)_`,
);

assert.equal(
  generateChangelogFrom("interface Example {}", "interface Example {}"),
  "",
);
