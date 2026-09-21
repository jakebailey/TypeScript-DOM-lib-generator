import { execSync } from "child_process";
import assert from "node:assert/strict";
import { readdir } from "fs/promises";
import {
  formatChangelogEntries,
  generateChangelogFrom,
} from "../src/changelog.ts";

const previousDeclarations = `
interface Request {
    readonly bodyUsed: boolean;
}
declare var Request: {
    prototype: Request;
    new(input: RequestInfo | URL): Request;
};
interface WindowOrWorkerGlobalScope {
    fetch(input: RequestInfo | URL): Promise<Response>;
}
interface XMLHttpRequest {
    open(method: string, url: string | URL): void;
}
declare function fetch(input: RequestInfo | URL): Promise<Response>;
`;

const currentDeclarations = `
interface Request {
    readonly bodyUsed: boolean;
}
declare var Request: {
    prototype: Request;
    new(input: RequestInfo | WorkerLocation | URL): Request;
};
interface WindowOrWorkerGlobalScope {
    fetch(input: RequestInfo | WorkerLocation | URL): Promise<Response>;
}
interface XMLHttpRequest {
    open(method: string, url: string | WorkerLocation | URL): void;
}
declare function fetch(input: RequestInfo | WorkerLocation | URL): Promise<Response>;
`;

assert.equal(
  generateChangelogFrom(previousDeclarations, currentDeclarations),
  `## Changed signatures

* \`WindowOrWorkerGlobalScope.fetch()\`
* \`XMLHttpRequest.open()\`
* \`Request\` constructor
* \`fetch()\``,
);

assert.equal(
  generateChangelogFrom(
    "interface Example { value: string; }",
    "/** Documentation. */\ninterface Example { value: string; }",
  ),
  "## Other changes\n\n* Declaration text changed.",
);

assert.equal(
  formatChangelogEntries([
    { notes: "## Modified\n\n* Example" },
    { group: "ts5.5", notes: "## Modified\n\n* Example" },
  ]),
  "## Modified\n\n* Example",
);

assert.equal(
  formatChangelogEntries([
    { notes: "" },
    { group: "ts5.5", notes: "## Modified\n\n* Example" },
    { group: "ts5.6", notes: "" },
  ]),
  `_TypeScript <=5.5 only_

## Modified

* Example`,
);

for (const filename of await readdir(new URL("files/", import.meta.url))) {
  if (filename.endsWith(".ts")) {
    execSync(
      `npx tsc generated/dom.generated.d.ts unittests/files/${filename} --target es2020 --lib es2020 --types --noEmit --ignoreConfig`,
      {
        stdio: "inherit",
      },
    );
  }
}

for (const filename of await readdir(
  new URL("files/audioworklet", import.meta.url),
)) {
  if (filename.endsWith(".ts")) {
    execSync(
      `npx tsc generated/audioworklet.generated.d.ts unittests/files/audioworklet/${filename} --target es2020 --lib es2020 --types --noEmit --ignoreConfig`,
      {
        stdio: "inherit",
      },
    );
  }
}
