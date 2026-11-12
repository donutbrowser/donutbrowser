import assert from "node:assert/strict";

/**
 * The MCP tools as an agent reaches them over the remote bridge, on one
 * initialized session. `tool` fails on an error answer; `toolError` expects one
 * and returns it.
 */
export async function mcpClient(base, token, profileId) {
  let rpcId = 0;
  let session = null;
  const post = async (method, params) => {
    const response = await fetch(`${base}/v1/e2e/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const answer = await response.json();
    session = answer.session_id ?? session;
    return answer.body;
  };
  const mcp = async (method, params) => {
    const body = await post(method, params);
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result;
  };
  const call = (name, args) =>
    post("tools/call", {
      name,
      arguments: { profile_id: profileId, ...args },
    });
  const tool = async (name, args = {}) => {
    const body = await call(name, args);
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.notEqual(body.result.isError, true, JSON.stringify(body.result));
    return body.result.content[0];
  };
  const toolJson = async (name, args) =>
    JSON.parse((await tool(name, args)).text);
  const toolError = async (name, args = {}) => {
    const body = await call(name, args);
    assert.ok(body.error, JSON.stringify(body));
    return body.error;
  };
  await mcp("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "Donut E2E", version: "1" },
  });
  return { mcp, call, tool, toolJson, toolError };
}
