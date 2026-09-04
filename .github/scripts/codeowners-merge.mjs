import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const codeownersUrl = new URL("../CODEOWNERS", import.meta.url);
const mergeMessageSignature = "<!-- Message About Merging -->";
const maintainerLabel = "maintainers";
const maintainers = ["sandersn", "jakebailey"];

function escapeRegExp(character) {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compilePattern(pattern) {
  const directoryPattern = pattern.endsWith("/");
  const patternWithoutTrailingSlash = directoryPattern
    ? pattern.slice(0, -1)
    : pattern;
  const rooted =
    pattern.startsWith("/") || patternWithoutTrailingSlash.includes("/");
  let normalized = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (directoryPattern) {
    normalized += "**";
  }
  const finalSegment = patternWithoutTrailingSlash.split("/").at(-1);
  const matchesDescendants =
    directoryPattern || (finalSegment && !/[*?]/.test(finalSegment));

  let source = "";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === "\\") {
      index++;
      if (index === normalized.length) {
        throw new Error(
          `Invalid trailing escape in CODEOWNERS pattern: ${pattern}`,
        );
      }
      source += escapeRegExp(normalized[index]);
    } else if (character === "*") {
      if (normalized[index + 1] === "*") {
        const startsSegment = index === 0 || normalized[index - 1] === "/";
        while (normalized[index + 1] === "*") {
          index++;
        }
        const endsSegment =
          index + 1 === normalized.length || normalized[index + 1] === "/";
        if (!startsSegment || !endsSegment) {
          source += "[^/]*";
        } else if (normalized[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }

  return new RegExp(
    `${rooted ? "^" : "(?:^|.*/)"}${source}${matchesDescendants && !directoryPattern ? "(?:/.*)?" : ""}$`,
  );
}

export function parseCodeowners(contents) {
  const rules = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const commentIndex = rawLine.indexOf("#");
    const line = rawLine
      .slice(0, commentIndex === -1 ? rawLine.length : commentIndex)
      .trim();
    if (!line) {
      continue;
    }

    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern.startsWith("!")) {
      throw new Error(
        `CODEOWNERS line ${index + 1} uses unsupported negation: ${pattern}`,
      );
    }
    if (pattern.includes("[") || pattern.includes("]")) {
      throw new Error(
        `CODEOWNERS line ${index + 1} uses unsupported character ranges: ${pattern}`,
      );
    }

    rules.push({ owners, pattern: compilePattern(pattern) });
  }
  return rules;
}

export function ownersForPath(rules, path) {
  let owners = [];
  for (const rule of rules) {
    if (rule.pattern.test(path)) {
      owners = rule.owners;
    }
  }
  return owners;
}

export function ownersForAllPaths(rules, paths) {
  if (!paths.length) {
    return [];
  }

  const ownerLists = paths.map((path) => ownersForPath(rules, path));
  return ownerLists[0].filter((owner, index, owners) => {
    const normalized = owner.toLowerCase();
    return (
      owners.findIndex(
        (candidate) => candidate.toLowerCase() === normalized,
      ) === index &&
      ownerLists.every((pathOwners) =>
        pathOwners.some((candidate) => candidate.toLowerCase() === normalized),
      )
    );
  });
}

export function isMergeCommand(body) {
  return body.trim().toLowerCase() === "lgtm";
}

async function loadCodeowners(codeowners) {
  return parseCodeowners(
    codeowners ?? (await readFile(codeownersUrl, { encoding: "utf8" })),
  );
}

async function getTree(github, repository, commitSha) {
  const commit = await github.rest.git.getCommit({
    ...repository,
    commit_sha: commitSha,
  });
  const tree = await github.rest.git.getTree({
    ...repository,
    tree_sha: commit.data.tree.sha,
    recursive: "1",
  });
  if (tree.data.truncated) {
    throw new Error(`Git tree ${commit.data.tree.sha} was truncated`);
  }
  return new Map(
    tree.data.tree
      .filter((entry) => entry.type !== "tree" && entry.path && entry.sha)
      .map((entry) => [
        entry.path,
        `${entry.mode ?? ""}:${entry.type ?? ""}:${entry.sha}`,
      ]),
  );
}

export async function getChangedFiles(github, repository, baseSha, headSha) {
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    ...repository,
    basehead: `${baseSha}...${headSha}`,
    per_page: 1,
  });
  const mergeBaseSha = comparison.data.merge_base_commit?.sha;
  if (!mergeBaseSha) {
    throw new Error(`Could not find a merge base for ${baseSha}...${headSha}`);
  }
  const [baseTree, headTree] = await Promise.all([
    getTree(github, repository, mergeBaseSha),
    getTree(github, repository, headSha),
  ]);

  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  return [...paths].filter((path) => baseTree.get(path) !== headTree.get(path));
}

async function ensureMaintainerLabel(github, repository) {
  const labels = await github.paginate(github.rest.issues.listLabelsForRepo, {
    ...repository,
    per_page: 100,
  });
  if (!labels.some((label) => label.name === maintainerLabel)) {
    await github.rest.issues.createLabel({
      ...repository,
      name: maintainerLabel,
      color: "ededed",
    });
  }
}

export async function announcePullRequest({ github, context, codeowners }) {
  const repository = context.repo;
  const pullRequest = context.payload.pull_request;
  if (!pullRequest) {
    throw new Error("The pull_request_target payload did not contain a PR");
  }

  const rules = await loadCodeowners(codeowners);
  const changedFiles = await getChangedFiles(
    github,
    repository,
    pullRequest.base.sha,
    pullRequest.head.sha,
  );
  const owners = ownersForAllPaths(rules, changedFiles);

  if (!owners.length) {
    await ensureMaintainerLabel(github, repository);
    await github.rest.issues.addLabels({
      ...repository,
      issue_number: pullRequest.number,
      labels: [maintainerLabel],
    });
    await github.rest.issues.addAssignees({
      ...repository,
      issue_number: pullRequest.number,
      assignees: maintainers,
    });
    return;
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repository,
    issue_number: pullRequest.number,
    per_page: 100,
  });
  if (
    comments.some((comment) => comment.body?.includes(mergeMessageSignature))
  ) {
    return;
  }

  const formattedOwners = new Intl.ListFormat().format(owners);
  await github.rest.issues.createComment({
    ...repository,
    issue_number: pullRequest.number,
    body: `Thanks for the PR!

This section of the codebase is owned by ${formattedOwners} - if they write a comment containing only "LGTM" then it will be merged.
${mergeMessageSignature}`,
  });
}

function fileLink(context, sha, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/blob/${sha}/${encodedPath}`;
}

async function comment(github, context, issueNumber, body) {
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: issueNumber,
    body,
  });
}

async function getCheckState(github, repository, headSha) {
  const checkRuns = await github.paginate(github.rest.checks.listForRef, {
    ...repository,
    ref: headSha,
    filter: "latest",
    per_page: 100,
  });
  if (!checkRuns.length) {
    return "NONE";
  }

  if (checkRuns.some((checkRun) => checkRun.status !== "completed")) {
    return "PENDING";
  }

  const successfulConclusions = new Set(["success", "neutral", "skipped"]);
  return checkRuns.every((checkRun) =>
    successfulConclusions.has(checkRun.conclusion),
  )
    ? "SUCCESS"
    : "FAILURE";
}

export async function mergePullRequest({ github, context, codeowners }) {
  const issue = context.payload.issue;
  const body = context.payload.comment?.body;
  if (!issue?.pull_request || typeof body !== "string") {
    throw new Error("The issue_comment payload did not contain a PR comment");
  }
  if (!isMergeCommand(body)) {
    throw new Error("The PR comment was not an LGTM merge command");
  }

  const repository = context.repo;
  const sender = context.payload.sender.login;
  const pullNumber = issue.number;
  const pullRequest = await github.rest.pulls.get({
    ...repository,
    pull_number: pullNumber,
  });
  if (pullRequest.data.state !== "open") {
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, this PR isn't open.`,
    );
    return;
  }

  const rules = await loadCodeowners(codeowners);
  const changedFiles = await getChangedFiles(
    github,
    repository,
    pullRequest.data.base.sha,
    pullRequest.data.head.sha,
  );
  // This automation intentionally grants merge authority to listed users even
  // when they do not otherwise have repository write access.
  const senderOwner = `@${sender}`.toLowerCase();
  const unauthorizedFiles = changedFiles.filter(
    (path) =>
      !ownersForPath(rules, path).some(
        (owner) => owner.toLowerCase() === senderOwner,
      ),
  );
  if (unauthorizedFiles.length) {
    const paths = unauthorizedFiles
      .map(
        (path) =>
          `* [\`${path}\`](${fileLink(context, pullRequest.data.head.sha, path)})`,
      )
      .join("\n");
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, you don't have access to these files:\n\n${paths}.`,
    );
    return;
  }

  if (pullRequest.data.mergeable === null) {
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, this PR is still computing mergeability. Please try again shortly.`,
    );
    return;
  }
  if (!pullRequest.data.mergeable) {
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, this PR has merge conflicts. They need to be fixed before it can be merged.`,
    );
    return;
  }

  const checkState = await getCheckState(
    github,
    repository,
    pullRequest.data.head.sha,
  );
  if (checkState !== "SUCCESS") {
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, this PR cannot be merged because its checks are ${checkState.toLowerCase()}.`,
    );
    return;
  }

  const currentPullRequest = await github.rest.pulls.get({
    ...repository,
    pull_number: pullNumber,
  });
  if (
    currentPullRequest.data.head.sha !== pullRequest.data.head.sha ||
    currentPullRequest.data.base.sha !== pullRequest.data.base.sha
  ) {
    await comment(
      github,
      context,
      pullNumber,
      `Sorry @${sender}, this PR changed while it was being checked. Please try again.`,
    );
    return;
  }

  try {
    const merge = await github.rest.pulls.merge({
      ...repository,
      pull_number: pullNumber,
      merge_method: "squash",
      sha: pullRequest.data.head.sha,
      commit_message: `Co-authored-by: ${sender} <${sender}@users.noreply.github.com>`,
    });
    if (!merge.data.merged) {
      throw new Error(merge.data.message || "GitHub declined the merge");
    }
  } catch (error) {
    const runUrl = `${context.serverUrl}/${repository.owner}/${repository.repo}/actions/runs/${context.runId}`;
    await comment(
      github,
      context,
      pullNumber,
      `There was an issue merging, maybe try again ${sender}. [Details](${runUrl})`,
    );
    throw error;
  }

  await comment(
    github,
    context,
    pullNumber,
    `Merging because @${sender} is a code owner of all the changes - thanks!`,
  );
}

async function main() {
  if (process.argv[2] !== "classify") {
    throw new Error(`Unknown command: ${process.argv[2] ?? ""}`);
  }
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is not set");
  }

  await appendFile(
    process.env.GITHUB_OUTPUT,
    `valid=${isMergeCommand(process.env.COMMENT_BODY ?? "")}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
