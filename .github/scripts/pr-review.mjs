// Turns the model's review of a pull request into the comment.
//
//   node .github/scripts/pr-review.mjs RESULT_JSON CHANGED_FILES OUTPUT_FILE
//
// The model returns findings as data. Only a finding on a file the pull
// request changes is kept, at most five. With no finding and no first-time
// thanks, OUTPUT_FILE is not written and nothing is posted.

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { reviewLine, unique } from "./bot-text.mjs";

const MAX_FINDINGS = 5;

export function renderReview({ result, changedFiles, firstTime = false }) {
  const changed = new Set(changedFiles);
  const seen = new Set();
  const findings = [];
  for (const finding of Array.isArray(result?.findings) ? result.findings : []) {
    const file = String(finding?.file ?? "").trim();
    const note = reviewLine(finding?.note);
    if (!changed.has(file) || !note) continue;
    if (unique([...seen, note]).length === seen.size) continue;
    seen.add(note);
    findings.push(`- \`${file}\`: ${note}`);
    if (findings.length === MAX_FINDINGS) break;
  }
  const parts = [];
  if (firstTime) parts.push("Thanks for your first PR!");
  if (findings.length) {
    parts.push(["Automated review. Check each point:", ...findings].join("\n"));
  }
  return parts.join("\n\n");
}

function main() {
  const [resultFile, filesFile, outFile] = process.argv.slice(2);
  if (!outFile) {
    console.error("usage: pr-review.mjs RESULT_JSON CHANGED_FILES OUTPUT_FILE");
    process.exit(2);
  }
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    // No answer: only the thanks can be posted.
  }
  const comment = renderReview({
    result,
    changedFiles: fs.readFileSync(filesFile, "utf8").split("\n").filter(Boolean),
    firstTime: process.env.FIRST_TIME === "true",
  });
  if (comment) fs.writeFileSync(outFile, comment);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
