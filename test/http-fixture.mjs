// Passive metadata only: observing a fixture must not consume its request body.
export function observeHttpFixture(server) {
  const requests = [];
  server.on("request", (request, response) => {
    const entry = {
      method: request.method,
      path: String(request.url || "").split("?")[0].split("/").slice(-2).join("/"),
      localPort: request.socket.localPort,
      requestEnded: request.readableEnded,
      responseFinished: response.writableFinished,
    };
    requests.push({ entry, response });
    if (requests.length > 100) requests.shift();
    request.once("end", () => { entry.requestEnded = true; });
    request.once("aborted", () => { entry.requestAborted = true; });
    response.once("finish", () => {
      entry.responseFinished = true;
      entry.status = response.statusCode;
    });
    response.once("close", () => {
      entry.responseClosed = true;
      entry.responseEnded = response.writableEnded;
      entry.status = response.statusCode;
    });
  });
  return () => requests.map(({ entry, response }) => ({
    ...entry,
    status: response.statusCode,
    headersSent: response.headersSent,
    responseFinished: response.writableFinished,
    responseEnded: response.writableEnded,
  }));
}

export function closeHttpFixture(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    // close() stops admission first; then dispose even a headers-only response
    // abandoned by a failing test, rather than waiting for its client's timeout.
    server.closeAllConnections();
  });
}

export function addHttpFixtureDiagnostic(error, details) {
  const detail = `HTTP fixture diagnostic: ${JSON.stringify(details)}`;
  const originalStack = error.stack;
  error.message += `\n${detail}`;
  if (typeof originalStack === "string") error.stack = `${originalStack}\n${detail}`;
}
