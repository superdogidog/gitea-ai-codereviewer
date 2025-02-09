import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { giteaApi } from "gitea-js";
import { fetch } from "cross-fetch";
import parseDiff, { Chunk, File } from "parse-diff";
const { simpleGit } = require("simple-git");

const GITEA_TOKEN: string = core.getInput("API_TOKEN_GITEA");
const GITEA_API_URL: string = core.getInput("API_URL_GITEA");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

// Initialize Gitea API client
const gitea = giteaApi(GITEA_API_URL, {
  token: GITEA_TOKEN,
  customFetch: fetch,
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  console.log("Process env:", process.env);
  const { repository, number, ...rest } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );

  console.log("Repository:", { ...rest, repository, number });
  console.log("Gitea:", GITEA_API_URL, GITEA_TOKEN);

  const prResponse = await gitea.repos.repoGetPullRequest(
    repository.owner.login,
    repository.name,
    number
  );

  console.log("PR Response:", prResponse);

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  // Using raw API endpoint for diff since gitea-js doesn't have a direct method
  const response = await fetch(
    `${GITEA_API_URL}/repos/${owner}/${repo}/pulls/${pull_number}.diff`,
    {
      headers: {
        Authorization: `token ${GITEA_TOKEN}`,
      },
    }
  );

  return response.ok ? await response.text() : null;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  .map((c) => {
    let lineNumber;
    if (c.type === "normal") {
      lineNumber = c.ln2;
    } else if (c.type === "add") {
      lineNumber = c.ln;
    } else if (c.type === "del") {
      lineNumber = c.ln;
    }

    return `${lineNumber} ${c.content}`;
  })
  .join("\n")} 
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  // Create review comments one by one
  // for (const comment of comments) {
  //   await gitea.repos.commentcreatePullReviewComment({
  //     owner,
  //     repo,
  //     index: pull_number,
  //     body: comment.body,
  //     path: comment.path,
  //     line: comment.line,
  //   });
  // }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  console.log("Event data:", eventData);

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronized") {
    const git = simpleGit();

    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    try {
      diff = await git.diff([`${newBaseSha}...${newHeadSha}`]);
    } catch (error) {
      console.error("Error getting diff with simple-git:", error);
      diff = null;
    }
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  console.log("Parsed diff:", parsedDiff);

  // const excludePatterns = core
  //   .getInput("exclude")
  //   .split(",")
  //   .map((s) => s.trim());

  // const filteredDiff = parsedDiff.filter((file) => {
  //   return !excludePatterns.some((pattern) =>
  //     minimatch(file.to ?? "", pattern)
  //   );
  // });

  const comments = await analyzeCode(parsedDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
