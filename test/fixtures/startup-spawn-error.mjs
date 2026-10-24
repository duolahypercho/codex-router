// Loaded only by the spawn-failure regression. The supervisor's executable
// passes its existence check, then disappears at the gateway spawn boundary.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const executable = args?.[0] === "--config"
    ? path.join(process.env.MODEL_ROUTER_STATE_DIR, "missing-gateway-executable")
    : command;
  const child = spawn(executable, args, options);
  if (child.pid) appendFileSync(process.env.CODEX_ROUTER_TEST_CHILD_PIDS, `${child.pid}\n`);
  return child;
};
syncBuiltinESMExports();
