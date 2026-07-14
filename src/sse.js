/** Minimal SSE parser that preserves events split across arbitrary network chunks. */
function createSseDataParser(onData) {
  let buffer = "";
  let dataLines = [];
  const dispatch = () => {
    if (!dataLines.length) return;
    onData(dataLines.join("\n"));
    dataLines = [];
  };
  const processLine = (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };
  return {
    feed(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      if (buffer) processLine(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    }
  };
}

export { createSseDataParser };
