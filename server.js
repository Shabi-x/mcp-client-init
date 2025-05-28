import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
    name: "weather",
    version: "1.0.0",
});

server.tool("getWeather", "get weather of a city", { city: z.string() }, async ({ city }) => {
    return {
        content: [
            {
                type: "text",
                text: `今天${city}的天气非常好，大晴天出太阳，但又不会太热，适合全家出门玩`,
            },
        ],
    };
});


server.tool('getTodayMatchResult', '获取今天的美职篮的一场比赛的结果', { date: z.string(), team1: z.string(), team2: z.string() }, async ({ date, team1, team2 }) => {

    return {
        content: [
            {
                type: 'text',
                text: `今日是${date}，${team1}和${team2}的比赛结果是：`
            }
        ]
    }
})
const transport = new StdioServerTransport();
await server.connect(transport);