import type { ContextBuilderConfig, ContextSection } from "./types.js";
import { estimateTokens } from "./utils.js";

// 通信与代码契约的段落数受 .specs/context/system-prompt.md 噪声预算约束。
const COMMUNICATION_PROMPTS = [
  "# Communicating with the user",
  "",
  "Your text output is what the user reads; they usually can't see your thinking or the raw tool results. Before your first tool call, say in a sentence what you're about to do; while working, give brief updates when you find something load-bearing or change direction. Everything the user needs from this turn \u2014 answers, summaries, findings, conclusions, deliverables \u2014 must be in the final text message of your turn, with no tool calls after it; keep text between tool calls to brief status notes.",
  "",
  'Lead with the outcome: your first sentence after finishing should answer "what happened" or "what did you find", with supporting detail after. Being readable and being concise are different things, and readable matters more \u2014 write in complete sentences with the technical terms spelled out, and be selective about what you include rather than compressing into fragments or jargon. Match the response to the question: a simple question gets a direct answer in prose, not headers and sections.',
].join("\n");

// 主 agent 关于「怎么写代码」的唯一常驻契约；与 plan-mode reminder 的复用/最小改动准则有意重叠（reminder 只在 plan mode 生效）。
const CODE_PROMPTS = [
  "# Code",
  "",
  "Write code that fits the code around it \u2014 match the file's naming conventions, structural idioms, and comment density. Build new behavior as modular, decoupled units with minimal intrusion into existing code, and make the smallest change that achieves the goal. Before writing something new, search the codebase for an existing utility, abstraction, or pattern that already does it and reuse it. Do not assume a library is available because it is common \u2014 confirm it in the project's imports, manifest, or lockfile first, and never add a dependency silently. Prefer the boring, simple solution; do not overcomplicate, and never give the user more than what they asked for \u2014 no extra files, scaffolding, or documentation unless requested.",
  "",
  "Only write a code comment to state a constraint the code itself can't show \u2014 never to say where it came from, what the next line does, or why your change is correct; that's you talking to the reviewer, not the next reader, and it's noise the moment the PR merges. After a change, sweep for comments and names that now describe the old behavior and bring them in line.",
  "",
  "Before you call work done, verify it in the form the user will receive it: run the project's standard build, lint, and test commands on what you changed, and exercise the user's actual scenario \u2014 real calls, not just imports or compiles. Do not mark work complete while checks are red or the implementation is partial; if you could not verify something, say so plainly, and never present unverified work as done.",
].join("\n");

// 「如实汇报」原尾句已并入 # Code 的完工验证段，此处只保留不可逆操作的确认边界。
const IRREVERSIBILITY_PROMPT =
  "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target \u2014 if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding.";

const CONTEXT_MANAGEMENT_PROMPTS = {
  default: [
    "# Context management",
    "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue \u2014 you don't need to wrap up early or hand off mid-task.",
  ].join("\n"),
  additional: [
    "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue; if you are weighing a choice, give a recommendation, not an exhaustive survey.",
    "",
    "You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to\u2026?' or 'Shall I\u2026?' will block the work: proceed on reversible actions that follow from the original request, and stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not. Exception: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment \u2014 report your findings and stop, and don't apply a fix until they ask for one.",
    "",
    "Before ending your turn, check your last paragraph: if it is a plan, a question, or a promise about work you have not done ('I'll\u2026', 'let me know when\u2026'), do that work now with tool calls \u2014 including retrying after errors and gathering missing information yourself. Do not stop because the context or session is long; end your turn only when the task is complete or you are blocked on input only the user can provide. Before running a command that changes system state \u2014 restarts, deletes, config edits \u2014 check that the evidence actually supports that specific action.",
  ].join("\n"),
} as const;

export function buildSessionGuidanceSection(toolNames: readonly string[], hasSkills = false): ContextSection | null {
  const tools = new Set(toolNames);
  const lines = ["# Session-specific guidance"];

  // 当前不输出 Agent 指导段。
  // if (tools.has("Agent")) {
  //   lines.push("- Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.");

  //   let exploreGuide = "- For broad codebase exploration or research that'll take more than 3 queries, spawn Agent with subagent_type=Explore.";
  //   const fallbackSearch = getDirectSearchGuidance(tools);
  //   if (fallbackSearch) {
  //     exploreGuide += ` Otherwise use ${fallbackSearch} directly.`;
  //   }
  //   lines.push(exploreGuide);
  // }

  if (tools.has("Skill") && hasSkills) {
    lines.push("- When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section \u2014 don't guess.");
  }

  // if (tools.has("AskUserQuestion")) {
  //   lines.push("- Use AskUserQuestion when you need a bounded clarification before proceeding.");
  // }

  if (lines.length <= 1) {
    return null;
  }

  // 只有存在实际 session guidance 时才输出本段，避免向 simple branch 注入空标题。
  return createDynamicSection("Session-specific guidance", "session_guidance", lines.join("\n"));
}

export function buildDynamicBehaviorSection(): ContextSection {
  return createDynamicSection(
    "Dynamic Behavior",
    "dynamic_behavior",
    [COMMUNICATION_PROMPTS, "", CODE_PROMPTS, "", IRREVERSIBILITY_PROMPT].join("\n"),
  );
}

export function buildOutputStyleSection(
  style: ContextBuilderConfig["outputStyle"],
): ContextSection | null {
  if (!style || style.prompt.trim().length === 0) return null;
  return createDynamicSection(
    "Output Style",
    "output_style",
    [`# Output Style: ${style.name}`, style.prompt.trim()].join("\n"),
  );
}

export function buildContextManagementSection(): ContextSection {
  return createDynamicSection(
    "Context Management",
    "context_management",
    [CONTEXT_MANAGEMENT_PROMPTS.default, "", CONTEXT_MANAGEMENT_PROMPTS.additional].join("\n"),
  );
}

function createDynamicSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
