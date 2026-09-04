import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  announcePullRequest,
  classifyMergeCommand,
  getCheckState,
  getChangedFiles,
  isMergeCommand,
  mergePullRequest,
  ownersForAllPaths,
  ownersForPath,
  parseCodeowners,
} from "./codeowners-merge.mjs";

const codeowners = `
src/**/*.ts @source-owner
baselines/* @baseline-owner
inputfiles/**/* @input-owner
README.md @docs-owner
*.md @markdown-owner
/README.md @root-docs-owner
apps/ @apps-owner
**/logs @logs-owner
/apps/github
`;

test("matches the supported CODEOWNERS patterns", () => {
  const rules = parseCodeowners(codeowners);

  assert.deepEqual(ownersForPath(rules, "src/index.ts"), ["@source-owner"]);
  assert.deepEqual(ownersForPath(rules, "src/nested/index.ts"), [
    "@source-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "src/index.js"), []);
  assert.deepEqual(ownersForPath(rules, "baselines/dom.generated.d.ts"), [
    "@baseline-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "baselines/nested/dom.d.ts"), []);
  assert.deepEqual(ownersForPath(rules, "inputfiles/file.json"), [
    "@input-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "inputfiles/nested/file.json"), [
    "@input-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "docs/guide.md"), ["@markdown-owner"]);
  assert.deepEqual(ownersForPath(rules, "README.md"), ["@root-docs-owner"]);
  assert.deepEqual(ownersForPath(rules, "nested/apps/file.js"), [
    "@apps-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "build/logs/output.txt"), [
    "@logs-owner",
  ]);
  assert.deepEqual(ownersForPath(rules, "apps/github/workflow.yml"), []);
});

test("uses the last matching rule", () => {
  const rules = parseCodeowners(`
*.ts @default
src/**/*.ts @source
src/generated/**/*.ts @generated
`);

  assert.deepEqual(ownersForPath(rules, "src/generated/file.ts"), [
    "@generated",
  ]);
});

test("finds owners common to every changed file", () => {
  const rules = parseCodeowners(`
src/**/* @one @two
src/generated/**/* @two
`);

  assert.deepEqual(
    ownersForAllPaths(rules, ["src/index.ts", "src/generated/file.ts"]),
    ["@two"],
  );
});

test("supports inline comments and owner resets", () => {
  const rules = parseCodeowners(`
*.ts @default # TypeScript files
generated/ # Anyone with write access may approve
`);

  assert.deepEqual(ownersForPath(rules, "src/index.ts"), ["@default"]);
  assert.deepEqual(ownersForPath(rules, "generated/index.ts"), []);
});

test("supports escaped spaces in patterns", () => {
  const rules = parseCodeowners(String.raw`
docs/My\ File.md @docs-owner
`);

  assert.deepEqual(ownersForPath(rules, "docs/My File.md"), ["@docs-owner"]);
});

test("rejects unsupported CODEOWNERS syntax", () => {
  assert.throws(
    () => parseCodeowners("generated/[ab].ts @owner"),
    /unsupported character ranges/,
  );
  assert.throws(
    () => parseCodeowners("!generated/file.ts @owner"),
    /unsupported negation/,
  );
});

test("matches every generated baseline in the repository", async () => {
  const contents = await readFile(new URL("../CODEOWNERS", import.meta.url), {
    encoding: "utf8",
  });
  const rules = parseCodeowners(contents);

  assert.deepEqual(ownersForPath(rules, "baselines/dom.generated.d.ts"), [
    "@saschanaz",
  ]);
  assert.deepEqual(ownersForPath(rules, "baselines/ts5.9/dom.generated.d.ts"), [
    "@saschanaz",
  ]);
});

test("accepts only an exact LGTM command", () => {
  assert.equal(isMergeCommand("LGTM"), true);
  assert.equal(isMergeCommand("  lgtm\n"), true);
  assert.equal(isMergeCommand("Looks LGTM!"), false);
  assert.equal(isMergeCommand("LGTM but wait"), false);
  assert.equal(isMergeCommand("`LGTM`"), false);
});

test("captures the reviewed head SHA with the merge command", async () => {
  const outputs = new Map();
  await classifyMergeCommand({
    github: {
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: "reviewed-head" } } }),
        },
      },
    },
    context: {
      repo: { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
      payload: {
        issue: { number: 123, pull_request: {} },
        comment: { body: "LGTM" },
      },
    },
    core: {
      setOutput: (name, value) => outputs.set(name, value),
    },
  });

  assert.equal(outputs.get("valid"), "true");
  assert.equal(outputs.get("head-sha"), "reviewed-head");
});

test("immutable diffs include both sides of a rename", async () => {
  const github = {
    rest: {
      git: {
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `${commit_sha}-tree` } },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            truncated: false,
            tree:
              tree_sha === "merge-base-tree"
                ? [
                    {
                      path: ".github/workflows/ci.yml",
                      mode: "100644",
                      type: "blob",
                      sha: "contents",
                    },
                  ]
                : [
                    {
                      path: "src/ci.ts",
                      mode: "100644",
                      type: "blob",
                      sha: "contents",
                    },
                  ],
          },
        }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base" } },
        }),
      },
    },
  };

  assert.deepEqual(
    await getChangedFiles(
      github,
      { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
      "base",
      "head",
    ),
    [".github/workflows/ci.yml", "src/ci.ts"],
  );
});

test("announces the owner who covers every changed file", async () => {
  const comments = [];
  const github = {
    paginate: async (method, parameters) => method(parameters),
    rest: {
      git: {
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `${commit_sha}-tree` } },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            truncated: false,
            tree:
              tree_sha === "merge-base-tree"
                ? []
                : [
                    {
                      path: "src/index.ts",
                      mode: "100644",
                      type: "blob",
                      sha: "source",
                    },
                    {
                      path: "inputfiles/overridingTypes.jsonc",
                      mode: "100644",
                      type: "blob",
                      sha: "input",
                    },
                  ],
          },
        }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base" } },
        }),
      },
      issues: {
        listComments: async () => [],
        createComment: async ({ body }) => {
          comments.push(body);
        },
      },
    },
  };
  const context = {
    repo: { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
    payload: {
      pull_request: {
        number: 123,
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
      },
    },
  };

  await announcePullRequest({
    github,
    context,
    codeowners: `
src/**/* @saschanaz
inputfiles/**/* @saschanaz
`,
  });

  assert.equal(comments.length, 1);
  assert.match(comments[0], /owned by @saschanaz/);
  assert.match(comments[0], /containing only "LGTM"/);
});

test("requires the baseline test workflow for direct baseline changes", async () => {
  const github = {
    paginate: async (method, parameters) => method(parameters),
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => [
          {
            name: "CI",
            run_number: 2,
            status: "completed",
            conclusion: "success",
          },
          {
            name: "CodeQL Advanced",
            run_number: 2,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      checks: {
        listForRef: async () => [
          {
            name: "license/cla",
            status: "completed",
            conclusion: "success",
            app: { slug: "microsoft-github-policy-service" },
          },
        ],
      },
    },
  };

  assert.equal(
    await getCheckState(
      github,
      { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
      "head-sha",
      ["baselines/dom.generated.d.ts"],
    ),
    "MISSING",
  );
});

test("merges a green PR at the verified head SHA", async () => {
  const calls = [];
  const github = {
    paginate: async (method, parameters) => method(parameters),
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => [
          {
            name: "CI",
            run_number: 2,
            status: "completed",
            conclusion: "success",
          },
          {
            name: "CodeQL Advanced",
            run_number: 2,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      checks: {
        listForRef: async () => [
          {
            name: "license/cla",
            status: "completed",
            conclusion: "success",
            app: { slug: "microsoft-github-policy-service" },
          },
        ],
      },
      git: {
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `${commit_sha}-tree` } },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            truncated: false,
            tree:
              tree_sha === "merge-base-tree"
                ? []
                : [
                    {
                      path: "src/index.ts",
                      mode: "100644",
                      type: "blob",
                      sha: "file-sha",
                    },
                  ],
          },
        }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            mergeable: true,
            head: { sha: "head-sha" },
            base: { sha: "base-sha" },
          },
        }),
        merge: async (parameters) => {
          calls.push(["merge", parameters]);
          return { data: { merged: true } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base" } },
        }),
      },
      issues: {
        createComment: async (parameters) => {
          calls.push(["comment", parameters]);
        },
      },
    },
  };
  const context = {
    repo: { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
    payload: {
      issue: { number: 123, pull_request: {} },
      comment: { body: "LGTM" },
      sender: { login: "saschanaz" },
    },
    runId: 456,
    serverUrl: "https://github.com",
  };

  await mergePullRequest({
    github,
    context,
    expectedHeadSha: "head-sha",
    codeowners: "src/**/*.ts @saschanaz",
  });

  const merge = calls.find(([kind]) => kind === "merge")[1];
  assert.equal(merge.sha, "head-sha");
  assert.equal(merge.merge_method, "squash");
  assert.match(merge.commit_message, /Co-authored-by: saschanaz/);
  assert.match(calls.at(-1)[1].body, /Merging because @saschanaz/);
});

test("does not merge when checks are pending", async () => {
  let merged = false;
  const comments = [];
  const github = {
    paginate: async (method, parameters) => method(parameters),
    rest: {
      actions: {
        listWorkflowRunsForRepo: async () => [
          {
            name: "CI",
            run_number: 2,
            status: "in_progress",
            conclusion: null,
          },
          {
            name: "CodeQL Advanced",
            run_number: 2,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      checks: {
        listForRef: async () => [
          {
            name: "license/cla",
            status: "completed",
            conclusion: "success",
            app: { slug: "microsoft-github-policy-service" },
          },
        ],
      },
      git: {
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `${commit_sha}-tree` } },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            truncated: false,
            tree:
              tree_sha === "merge-base-tree"
                ? []
                : [
                    {
                      path: "src/index.ts",
                      mode: "100644",
                      type: "blob",
                      sha: "file-sha",
                    },
                  ],
          },
        }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            mergeable: true,
            head: { sha: "head-sha" },
            base: { sha: "base-sha" },
          },
        }),
        merge: async () => {
          merged = true;
          return { data: { merged: true } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base" } },
        }),
      },
      issues: {
        createComment: async ({ body }) => {
          comments.push(body);
        },
      },
    },
  };
  const context = {
    repo: { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
    payload: {
      issue: { number: 123, pull_request: {} },
      comment: { body: "LGTM" },
      sender: { login: "saschanaz" },
    },
    runId: 456,
    serverUrl: "https://github.com",
  };

  await mergePullRequest({
    github,
    context,
    expectedHeadSha: "head-sha",
    codeowners: "src/**/*.ts @saschanaz",
  });

  assert.equal(merged, false);
  assert.match(comments[0], /checks are pending/);
});

test("does not merge a PR with no changed files", async () => {
  let merged = false;
  const comments = [];
  const github = {
    paginate: async (method, parameters) => method(parameters),
    rest: {
      git: {
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `${commit_sha}-tree` } },
        }),
        getTree: async () => ({
          data: {
            truncated: false,
            tree: [],
          },
        }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            mergeable: true,
            head: { sha: "head-sha" },
            base: { sha: "base-sha" },
          },
        }),
        merge: async () => {
          merged = true;
          return { data: { merged: true } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: "merge-base" } },
        }),
      },
      issues: {
        createComment: async ({ body }) => {
          comments.push(body);
        },
      },
    },
  };
  const context = {
    repo: { owner: "microsoft", repo: "TypeScript-DOM-lib-generator" },
    payload: {
      issue: { number: 123, pull_request: {} },
      comment: { body: "LGTM" },
      sender: { login: "not-a-codeowner" },
    },
    runId: 456,
    serverUrl: "https://github.com",
  };

  await mergePullRequest({
    github,
    context,
    expectedHeadSha: "head-sha",
    codeowners: "src/**/*.ts @saschanaz",
  });

  assert.equal(merged, false);
  assert.match(comments[0], /no changed files owned by a code owner/);
});
