import { config } from "./config.js";
import { logger } from "./logger.js";
import { createServer } from "./webdavServer.js";

const server = createServer();

server.listen(config.port, config.bindAddress, () => {
  logger.info(
    { bind: config.bindAddress, port: config.port, rommBaseUrl: config.rommBaseUrl },
    "retroarch-webdav-romm shim listening",
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info({ sig }, "shutting down");
    server.close(() => process.exit(0));
  });
}
