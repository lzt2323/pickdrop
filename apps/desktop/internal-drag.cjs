const path = require('node:path');
// Electron's native file drag has no custom MIME payload. Match its real file
// path, never its display name, and retain an ended session briefly because
// separate renderer processes can deliver dragend before the target's drop IPC.
function createInternalDragRegistry({ now = Date.now, platform = process.platform, settleMs = 1500 } = {}) {
  let session;
  const normalize = value => {
    if (typeof value !== 'string' || !value) return null;
    const result = (platform === 'win32' ? path.win32 : path).resolve(value);
    return platform === 'win32' ? result.toLowerCase() : result;
  };
  return {
    begin(source, file) { session = { source, file: normalize(file), expires: now() + 10 * 60 * 1000 }; },
    end(source) { if (session?.source === source) session.expires = Math.min(session.expires, now() + settleMs); },
    cancel(source) { if (session?.source === source) session = undefined; },
    allowedIndexes(files) {
      if (session && session.expires < now()) session = undefined;
      return files.map((file, index) => ({ file: normalize(file), index }))
        .filter(item => !session?.file || item.file !== session.file).map(item => item.index);
    },
  };
}
module.exports = { createInternalDragRegistry };
