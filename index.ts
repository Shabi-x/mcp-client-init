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
        // console.log("\n可用工具列表:", JSON.stringify(openAITools, null, 2));

        const response = await this.openai.chat.completions.create({
            model: "qwen-plus",
            messages,
            tools: openAITools,
        });

        const choice = response.choices[0];
        if (!choice.message.tool_calls) {
            return choice.message.content || "抱歉，我不太理解您的问题。";
        }

        const results = [];
        for (const toolCall of choice.message.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments);

            console.log(`\n大模型决定调用工具: ${toolName}`);
            console.log("调用参数:", toolArgs);
            
            const result = await this.mcp.callTool({
                name: toolName,
                arguments: toolArgs,
            });

            if (result.content) {
                if (Array.isArray(result.content)) {
                    const text = result.content.map(item => item.text).join('');
                    results.push(text);
                } else {
                    results.push(result.content);
                }
            }

            messages.push({
                role: "assistant",
                content: null,
                tool_calls: [toolCall],
            });

            messages.push({
                role: "tool",
                content: JSON.stringify(result.content),
                tool_call_id: toolCall.id,
            });
        }

        const finalResponse = await this.openai.chat.completions.create({
            model: "qwen-plus",
            messages,
        });
        console.log("大模型生成的最终回答:", finalResponse.choices[0].message.content);

        results.push(finalResponse.choices[0].message.content || "");
        return results.join("\n\n");
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
                console.log("\n响应:", response);
            }
        } catch (e) {
            console.log("错误:", e);
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
