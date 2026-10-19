import http from "node:http";

const scenario = process.env.NODE_FIXTURE_SCENARIO;
if (scenario === "exit") {
  process.stderr.write("fixture initialization failed\n");
  process.exit(7);
}
await new Promise(resolve => setTimeout(resolve, Number(process.env.NODE_FIXTURE_DELAY_MS || 0)));
http.createServer((_request, response) => {
  process.send?.({ nodeFixtureRequest: true });
  if (scenario === "stall-body") {
    response.writeHead(200, { "Content-Length": "1" });
    response.flushHeaders();
  } else {
    response.writeHead(scenario === "not-ready" ? 503 : 200);
    response.end("ready");
  }
}).listen(Number(process.env.NODE_FIXTURE_PORT), "127.0.0.1");
