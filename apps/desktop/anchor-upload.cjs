// Disk-backed Blob bodies stay streamed. Progress means bytes handed to the
// request; 100% remains "confirming" until the server acknowledges persistence.
async function sendAnchorFile({ blob, url, headers, signal, fetch, progress }) {
  signal.throwIfAborted();
  let loaded = 0,
    reportedAt = 0;
  const body = blob.stream().pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        signal.throwIfAborted();
        loaded += chunk.byteLength;
        const now = Date.now();
        if (loaded === blob.size || now - reportedAt >= 80) {
          reportedAt = now;
          progress(loaded);
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const response = await fetch(url, { method: 'POST', headers, body, duplex: 'half', signal });
  if (!response.ok) throw new Error(`文件发送失败 (${response.status})`);
  signal.throwIfAborted();
  return true;
}
module.exports = { sendAnchorFile };
