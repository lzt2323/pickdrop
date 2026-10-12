export function invitationAddress(value) {
  const url = new URL(String(value).trim().includes('://') ? String(value).trim() : `http://${String(value).trim()}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') throw new Error('请输入有效的设备地址');
  return { address: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80'), baseUrl: url.origin };
}
export function invitationUrl(address, port, code) {
  if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位数字邀请码');
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('请输入 1–65535 的端口');
  const url = new URL(invitationAddress(address).baseUrl); url.port = port; url.hash = `invite=${code}`;
  return url.toString();
}
// The readable three fields travel with the original link so its signed group
// identity and protocol hint survive copy/paste; neither is guessed from the IP.
export function invitationText(invite) {
  const { address, port } = invitationAddress(invite.baseUrl || invite.link.split('/#')[0]);
  return `邀请码：${invite.code}\n地址：${address}\n端口：${port}\n邀请链接：${invite.link}`;
}
export function parseInvitation(value) {
  const text = String(value).trim();
  const link = text.match(/https?:\/\/[^\s]+#[^\s]+/i)?.[0];
  if (link) {
    const url = new URL(link), fields = invitationAddress(url.toString()), params = new URLSearchParams(url.hash.slice(1));
    const code = params.get('invite');
    if (!/^\d{6}$/.test(code || '')) throw new Error('邀请信息缺少 6 位邀请码');
    const groupId = params.get('group') || undefined;
    if (groupId && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(groupId)) throw new Error('邀请中的群编号不正确');
    return { ...fields, code, groupId, link: url.toString() };
  }
  const code = text.match(/邀请码\s*[:：]\s*(\d{6})(?!\d)/)?.[1];
  const address = text.match(/地址\s*[:：]\s*([^\s]+)/)?.[1];
  const port = text.match(/端口\s*[:：]\s*(\d+)/)?.[1];
  if (!code || !address || !port) return null;
  return { ...invitationAddress(address), port, code, link: invitationUrl(address, port, code) };
}
