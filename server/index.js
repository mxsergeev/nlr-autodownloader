import app from "./app.js";
import { config } from "./config.js";
import "./workers/metadata.worker.js";
import "./workers/search.worker.js";
import "./workers/download.worker.js";

const port = config.serverPort;

// Set umask to allow group write permissions for created files and directories
process.umask(0o002);

app.listen(port, () => {
  console.log(`NLR-AUTODOWNLOADER listening on port ${port}`);
});
