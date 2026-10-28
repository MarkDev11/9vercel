import { describe, it, expect } from "vitest";
import {
  buildToolConversationPrompt,
  parseDeepSeekToolCalls,
} from "../../open-sse/translator/deepseekWebTools.js";
import {
  finalizeBoundCalls,
  finalizeParsedToolCalls,
} from "../../open-sse/translator/deepseekWebToolBinding.js";

describe("deepseek-web long task coding harness enhancements", () => {
  const sampleTools = [
    {
      type: "function",
      function: {
        name: "execute_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            diff: { type: "string" },
          },
          required: ["path", "diff"],
          additionalProperties: false,
        },
      },
    },
  ];

  it("fail-open: finalizeParsedToolCalls retains tool calls even if arguments have extra properties", () => {
    const rawText = "Calling edit_file";
    const parsed = {
      content: rawText,
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "edit_file",
            // Notice: has extra field "explanation" and "_nonce"
            arguments: JSON.stringify({
              path: "src/main.js",
              diff: "- old\n+ new",
              explanation: "fixing syntax error",
              _nonce: "nonce123",
            }),
          },
        },
      ],
    };

    const finalized = finalizeParsedToolCalls(rawText, parsed, sampleTools);
    expect(finalized.toolCalls).not.toBeNull();
    expect(finalized.toolCalls).toHaveLength(1);
    const args = JSON.parse(finalized.toolCalls[0].function.arguments);
    expect(args.path).toBe("src/main.js");
    expect(args.diff).toBe("- old\n+ new");
    expect(args.explanation).toBe("fixing syntax error");
    // _nonce must be stripped cleanly
    expect(args._nonce).toBeUndefined();
  });

  it("fail-open: finalizeBoundCalls retains tool calls and strips _nonce", () => {
    const rawText = "Calling execute_command";
    const parsed = {
      content: rawText,
      toolCalls: [
        {
          id: "call_2",
          type: "function",
          function: {
            name: "execute_command",
            arguments: JSON.stringify({
              command: "npm test",
              cwd: "/app", // extra property
              _nonce: "randomNonce",
            }),
          },
        },
      ],
    };

    const finalized = finalizeBoundCalls(rawText, parsed, sampleTools);
    expect(finalized.toolCalls).not.toBeNull();
    expect(finalized.toolCalls).toHaveLength(1);
    const args = JSON.parse(finalized.toolCalls[0].function.arguments);
    expect(args.command).toBe("npm test");
    expect(args.cwd).toBe("/app");
    expect(args._nonce).toBeUndefined();
  });

  it("buildToolConversationPrompt enforces autonomous continuation until completion", () => {
    const messages = [
      { role: "user", content: "Build a web server in Go." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "execute_command", arguments: '{"command":"go mod init"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "execute_command", content: "go: creating new go.mod" },
    ];

    const prompt = buildToolConversationPrompt(messages, "System: tool definitions");
    expect(prompt).toContain("You are working autonomously in a coding harness");
    expect(prompt).toContain("MUST call the next appropriate tool");
    expect(prompt).toContain("Only give a final conversational answer when the entire objective requested by the user is 100% finished");
    // Ensure the old premature invitation is gone
    expect(prompt).not.toContain("perform the next step or give the final answer.");
  });

  it("buildToolConversationPrompt truncates oversized individual tool results to prevent context blowout", () => {
    const hugeToolOutput = "line of log data\n".repeat(500); // ~8500 chars
    const messages = [
      { role: "user", content: "Analyze the build logs." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_log",
            function: { name: "execute_command", arguments: '{"command":"cat log.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_log", name: "execute_command", content: hugeToolOutput },
    ];

    const prompt = buildToolConversationPrompt(messages, "");
    expect(prompt.length).toBeLessThan(hugeToolOutput.length);
    expect(prompt).toContain("characters truncated for context window");
  });

  it("buildToolConversationPrompt maintains a rolling window preserving the root user prompt", () => {
    const messages = [
      { role: "user", content: "ROOT_TASK: Implement user authentication with JWT and bcrypt" },
    ];

    // Simulate 30 turns of coding iterations
    for (let i = 1; i <= 30; i++) {
      messages.push({
        role: "assistant",
        content: `Iteration ${i}`,
        tool_calls: [
          {
            id: `call_${i}`,
            function: { name: "execute_command", arguments: `{"command":"step ${i}"}` },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call_${i}`,
        name: "execute_command",
        content: `Result of step ${i}`,
      });
    }

    const prompt = buildToolConversationPrompt(messages, "");
    // Must keep the root task
    expect(prompt).toContain("ROOT_TASK: Implement user authentication with JWT and bcrypt");
    // Must note omitted turns
    expect(prompt).toContain("[... earlier conversation turns omitted for brevity ...]");
    // Must contain the most recent iteration
    expect(prompt).toContain("Result of step 30");
  });

  it("parseDeepSeekToolCalls successfully parses tool call even if located in reasoning text", () => {
    const reasoningText = "I need to check the file. Let me call read_file.\n<tool>{\"name\": \"execute_command\", \"arguments\": {\"command\": \"git status\"}}</tool>";
    const parsed = parseDeepSeekToolCalls(reasoningText, "call_test", sampleTools);
    expect(parsed.toolCalls).not.toBeNull();
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].function.name).toBe("execute_command");
    const args = JSON.parse(parsed.toolCalls[0].function.arguments);
    expect(args.command).toBe("git status");
  });
});
