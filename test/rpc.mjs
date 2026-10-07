// Copied from core/test/rpc.mjs by scripts/sync-core.mjs. Edit it there, then run npm run sync at the repo root.
// A JSON-RPC server on localhost that answers what viem asks before it sends, and records every call: so a test can
// see the transaction a wallet would have broadcast, without a chain.
import http from "node:http";

export async function fakeRpc() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const one = (m) => {
        calls.push(m);
        const r = {
          eth_chainId: "0x1237",
          eth_getTransactionCount: "0x0",
          eth_maxPriorityFeePerGas: "0x0",
          eth_gasPrice: "0x989680",
          eth_estimateGas: "0x5208",
          eth_getBalance: "0xde0b6b3a7640000",
          eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
          eth_blockNumber: "0x2",
          eth_getTransactionByHash: { hash: `0x${"ab".repeat(32)}`, blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", transactionIndex: "0x0", from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, gas: "0x5208", gasPrice: "0x989680", maxFeePerGas: "0x989680", maxPriorityFeePerGas: "0x0", input: "0x", nonce: "0x0", value: "0x0", type: "0x2", chainId: "0x1237", v: "0x0", r: `0x${"01".repeat(32)}`, s: `0x${"01".repeat(32)}`, yParity: "0x0", accessList: [] },
          eth_getTransactionReceipt: { transactionHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1", from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x989680", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2" },
          eth_getBlockByNumber: { number: "0x1", hash: `0x${"cd".repeat(32)}`, parentHash: `0x${"00".repeat(32)}`, timestamp: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x989680", transactions: [], difficulty: "0x0", extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, miner: `0x${"00".repeat(20)}`, nonce: "0x0000000000000000", size: "0x1", stateRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, sha3Uncles: `0x${"00".repeat(32)}`, uncles: [] },
        }[m.method];
        return r === undefined ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no ${m.method}` } } : { jsonrpc: "2.0", id: m.id, result: r };
      };
      const out = Array.isArray(body) ? body.map(one) : one(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise((r) => server.close(r)) };
}
