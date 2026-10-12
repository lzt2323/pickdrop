import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { invitationAddress, invitationUrl, parseInvitation } from '../shared/invitation.js';

const source = readFileSync(new URL('../apps/desktop/public/app.js', import.meta.url), 'utf8');
const openJoinCode = source.slice(source.indexOf('function openJoin()'), source.indexOf('function openPending('));

function fixture() {
  const fields = new Map(), actions = new Map(), joins = [];
  const input = (_placeholder, id) => {
    const listeners = new Map();
    const field = {
      value: '', classList: { add() {} }, setAttribute() {}, focus() {},
      addEventListener(name, callback) { listeners.set(name, callback); },
      dispatch(name, text) {
        if (name === 'paste') listeners.get(name)?.({ clipboardData: { getData: () => text }, preventDefault() {} });
        else if (name === 'input') this.oninput?.();
        else listeners.get(name)?.();
      },
    };
    fields.set(id, field);
    return field;
  };
  const bridge = { async joinAt(...args) { joins.push(args); return { groupName: '测试群' }; } };
  const context = vm.createContext({
    URL, bridge, pendingTicket: null, invitationAddress, invitationUrl, parseInvitation,
    input, openPanel: () => ({ append() {} }), openPending() {},
    action(label, handler, _className, id) { const button = { label, handler, disabled: false }; if (id) actions.set(id, button); return button; },
    fieldLabel() {}, element: () => ({ append() {} }), toast() {}, showError(error) { throw error; },
  });
  vm.runInContext(`${openJoinCode}\nopenJoin();`, context);
  return {
    fields,
    joins,
    async paste(text) { fields.get('join-address').dispatch('paste', text); },
    edit(id, value) { const field = fields.get(id); field.value = value; field.dispatch('input'); },
    async submit() { await actions.get('confirm-join-group').handler(); },
    blurAddress() { fields.get('join-address').dispatch('change'); },
  };
}

const id = '11111111-1111-4111-8111-111111111111';

test('desktop keeps the original group ID only while the pasted invitation is unchanged', async () => {
  const invite = `http://192.0.2.10:51854/#invite=123456&group=${id}`;
  const unchanged = fixture(); await unchanged.paste(invite); await unchanged.submit();
  assert.deepEqual(unchanged.joins[0], ['http://192.0.2.10:51854', '123456', id]);

  for (const [field, value, expectedBase, expectedCode] of [
    ['join-code', '654321', 'http://192.0.2.10:51854', '654321'],
    ['join-port', '51855', 'http://192.0.2.10:51855', '123456'],
    ['join-address', '192.0.2.11', 'http://192.0.2.11:51854', '123456'],
  ]) {
    const changed = fixture(); await changed.paste(invite); changed.edit(field, value); await changed.submit();
    assert.deepEqual(changed.joins[0], [expectedBase, expectedCode, undefined], field);
  }
});

test('desktop preserves HTTPS invitations and does not reset an IPv6 port on blur or submit', async () => {
  const secure = fixture(); await secure.paste(`https://example.test:8443/#invite=123456&group=${id}`);
  assert.equal(secure.fields.get('join-address').value, 'https://example.test');
  secure.blurAddress(); await secure.submit();
  assert.deepEqual(secure.joins[0], ['https://example.test:8443', '123456', id]);

  const ipv6 = fixture(); await ipv6.paste(`http://[::1]:51854/#invite=123456&group=${id}`);
  assert.equal(ipv6.fields.get('join-address').value, '[::1]');
  ipv6.blurAddress(); assert.equal(ipv6.fields.get('join-port').value, '51854');
  await ipv6.submit();
  assert.deepEqual(ipv6.joins[0], ['http://[::1]:51854', '123456', id]);
});
