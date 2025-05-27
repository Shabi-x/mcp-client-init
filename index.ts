import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
if (!OPENAI_API_KEY || !OPENAI_BASE_URL) {
    throw new Error("OPENAI_API_KEY 或 OPENAI_BASE_URL 未设置");
}

interface MCPTool {
    name: string;
    description?: string;
    inputSchema: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

class MCPClient {
    private mcp: Client;
    private openai: OpenAI;
    private transport: StdioClientTransport | null = null;
    private tools: MCPTool[] = [];

    constructor() {
        this.openai = new OpenAI({
            apiKey: OPENAI_API_KEY,
            baseURL: OPENAI_BASE_URL,
        });
        this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
    }
    // 连接到 MCP 服务器
    async connectToServer(serverScriptPath: string) {
        try {
            // server地址是属于js还是py
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("服务器脚本必须是 .js 或 .py 文件");
            }
            const command = isPy
                ? process.platform === "win32"
                    ? "python"
                    : "python3"
                : process.execPath;

            this.transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });
            this.mcp.connect(this.transport);

            const toolsResult = await this.mcp.listTools();
            // 获取此mcp server内所有的可用的工具列表
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                };
            });
            console.log(
                "已连接到服务器，工具包括：",
                this.tools.map(({ name }) => name)
            );
        } catch (e) {
            console.log("无法连接到 MCP 服务器: ", e);
            throw e;
        }
    }

    // 处理用户输入的query
    async processQuery(query: string) {
        const messages: ChatCompletionMessageParam[] = [
            {
                role: "user",
                content: query,
            },
        ];

        // 将MCP工具转换为OpenAI格式
        const openAITools = this.tools.map(tool => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description || "",
                parameters: {
                    type: "object",
                    properties: tool.inputSchema.properties || {},
                    required: tool.inputSchema.required || []
                }
            }
        }));

        const response = await this.openai.chat.completions.create({
            model: "qwen-plus",
            messages,
            tools: openAITools,
        });

        const finalText = [];
        const toolResults = [];

        const choice = response.choices[0];
        if (!choice.message.tool_calls) {
            return choice.message.content || "";
        }

        for (const toolCall of choice.message.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);

            const result = await this.mcp.callTool({
                name: toolName,
                arguments: toolArgs,
            });
            toolResults.push(result);
            finalText.push(
                `[调用工具 ${toolName}，参数 ${JSON.stringify(toolArgs)}]`
            );

            messages.push({
                role: "assistant",
                content: "",
                tool_calls: [toolCall],
            });

            messages.push({
                role: "tool",
                content: result.content as string,
                tool_call_id: toolCall.id,
            });

            const followUpResponse = await this.openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages,
            });

            finalText.push(followUpResponse.choices[0].message.content || "");
        }

        return finalText.join("\n");
    }

    // 对话循环
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        try {
            console.log("\nMCP 客户端已启动！");
            console.log("输入你的查询或输入 'quit' 退出。");

            while (true) {
                const message = await rl.question("\n查询: ");
                if (message.toLowerCase() === "quit") {
                    break;
                }
                const response = await this.processQuery(message);
                console.log("\n" + response);
            }
        } finally {
            rl.close();
        }
    }

    async cleanup() {
        await this.mcp.close();
    }


}

/**
 * 主函数，用于初始化和运行MCP客户端
 * @returns {Promise<void>}
 */
async function main() {
    if (process.argv.length < 3) {
        console.log("使用方法: node index.ts <path_to_server_script>");
        return;
    }
    const mcpClient = new MCPClient();
    try {
        await mcpClient.connectToServer(process.argv[2]);
        await mcpClient.chatLoop();
    } finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}

main();
