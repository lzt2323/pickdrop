import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
function setup(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
  const screen = new EventEmitter();
  let cursor = { x: -1000, y: -1000 },
    id = 0;
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 30, width: 1440, height: 840 },
  };
  Object.assign(screen, {
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
    getAllDisplays: () => [display],
    getCursorScreenPoint: () => cursor,
  });
  const context = {
    require: () => ({ screen }),
    module: { exports: {} },
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(
    readFileSync(new URL('../apps/desktop/split-window-controller.cjs', import.meta.url), 'utf8'),
    context,
  );
  function window(bounds) {
    const w = new EventEmitter();
    let box = { ...bounds },
      visible = true,
      destroyed = false;
    Object.assign(w, {
      id: ++id,
      calls: [],
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isFocused: () => false,
      getBounds: () => ({ ...box }),
      setBounds(b) {
        box = { ...b };
        w.calls.push(['bounds', b]);
        w.emit('move');
      },
      setIgnoreMouseEvents(v) {
        w.ignores = v;
      },
      showInactive() {
        visible = true;
      },
      show() {
        visible = true;
      },
      hide() {
        visible = false;
      },
      focus() {
        w.calls.push(['focus']);
      },
      destroy() {
        destroyed = true;
        w.emit('closed');
      },
      webContents: {
        send(channel, value) {
          w.calls.push([channel, structuredClone(value)]);
        },
        isDestroyed: () => false,
      },
    });
    return w;
  }
  function make(saved = {}, bounds = { x: 1100, y: 200, width: 340, height: 470 }) {
    const win = window(bounds),
      anchor = window({ x: 0, y: 0, width: 56, height: 56 }),
      savedValues = [];
    anchor.hide();
    const c = context.module.exports.createSplitWindowController(win, anchor, saved, (v) =>
      savedValues.push(structuredClone(v)),
    );
    t.after(() => win.destroy());
    return { c, win, anchor, savedValues };
  }
  const tick = (ms) => {
    for (let n = 0; n < ms; n += 16) t.mock.timers.tick(Math.min(16, ms - n));
  };
  return {
    ...make(),
    make,
    screen,
    display,
    tick,
    cursor: (p) => {
      cursor = p;
    },
    ready: (c) => c.panelReady(c.state().motionSequence),
  };
}
test('collapse keeps full panel bounds, hides its native hit area, and uses a separate 56px anchor', (t) => {
  const { c, win, anchor, tick } = setup(t);
  c.dock();
  const b = win.getBounds(),
    before = win.calls.filter((x) => x[0] === 'bounds').length;
  tick(200);
  assert.equal(c.state().collapsed, true);
  assert.equal(win.isVisible(), false);
  assert.equal(win.ignores, true);
  assert.equal(anchor.getBounds().width, 56);
  assert.equal(anchor.isVisible(), true);
  assert.deepEqual(win.getBounds(), b);
  assert.equal(win.calls.filter((x) => x[0] === 'bounds').length, before);
  assert.notEqual(c.state().contentWindowId, c.state().tabWindowId);
});
test('reveal waits for matching renderer preparation ACK and ignores stale ACK after hiding', (t) => {
  const { c, win, tick, ready } = setup(t);
  c.dock();
  tick(200);
  c.expand();
  const stale = c.state().motionSequence;
  assert.equal(c.state().transition, 'prepare');
  assert.equal(win.isVisible(), false);
  c.hide();
  c.panelReady(stale);
  assert.equal(win.isVisible(), false);
  c.expand();
  ready(c);
  assert.equal(win.isVisible(), true);
  assert.equal(win.ignores, false);
  tick(220);
  assert.equal(c.state().transition, '');
});
test('rapid reveal/collapse reversals keep native dimensions and latest visibility intent', (t) => {
  const { c, win, tick, ready } = setup(t);
  c.dock();
  tick(200);
  c.expand();
  ready(c);
  tick(48);
  const b = win.getBounds();
  c.collapse(true);
  tick(48);
  c.expand();
  tick(240);
  assert.deepEqual(win.getBounds(), b);
  assert.equal(c.state().collapsed, false);
  assert.equal(win.isVisible(), true);
});
test('content drag does not snap until release, then shows adjacent panel', (t) => {
  const { c, win, cursor, tick } = setup(t);
  cursor({ x: 1250, y: 220 });
  c.startWindowDrag();
  cursor({ x: 1280, y: 260 });
  tick(32);
  assert.equal(c.state().moving, true);
  assert.equal(c.state().candidateEdge, 'right');
  assert.equal(c.state().edge, null);
  c.endWindowDrag();
  assert.equal(c.state().edge, 'right');
  assert.equal(win.getBounds().x + 340 + 8, 1440 - 56);
});
test('anchor pull-out keeps hidden content hidden until release and preparation ACK', (t) => {
  const { c, win, anchor, cursor, tick, ready } = setup(t);
  c.dock();
  tick(200);
  const b = anchor.getBounds();
  cursor({ x: b.x + 20, y: b.y + 20 });
  c.startWindowDrag('anchor');
  cursor({ x: b.x - 180, y: b.y + 60 });
  tick(32);
  assert.equal(c.state().moving, true);
  assert.equal(win.isVisible(), false);
  assert.equal(anchor.getBounds().width, 56);
  c.endWindowDrag();
  assert.equal(c.state().edge, null);
  assert.equal(win.isVisible(), false);
  ready(c);
  assert.equal(win.isVisible(), true);
  assert.equal(win.getBounds().width, 340);
  assert.equal(anchor.isVisible(), false);
});
test('hide cancels pending file reveal and pointer polling drag', (t) => {
  const { c, win, anchor, tick, cursor } = setup(t);
  c.dock();
  tick(200);
  c.dragActivity(true);
  c.hide();
  tick(300);
  assert.equal(win.isVisible(), false);
  assert.equal(anchor.isVisible(), false);
  c.expand();
  c.panelReady(c.state().motionSequence);
  cursor({ x: 700, y: 200 });
  c.startWindowDrag();
  cursor({ x: 800, y: 240 });
  tick(32);
  c.hide();
  const b = win.getBounds();
  cursor({ x: 1000, y: 600 });
  tick(1000);
  assert.deepEqual(win.getBounds(), b);
  assert.equal(c.state().moving, false);
  assert.equal(win.isVisible(), false);
});
test('pin and native operations prevent automatic collapse; reduced motion settles immediately', (t) => {
  const { c, win, tick } = setup(t);
  c.setPinned(true);
  c.dock();
  tick(1200);
  assert.equal(c.state().collapsed, false);
  c.setPinned(false);
  c.setBusy('native', true);
  tick(1200);
  assert.equal(c.state().collapsed, false);
  c.setBusy('native', false);
  tick(850);
  c.setReducedMotion(true);
  assert.equal(c.state().transition, '');
  assert.equal(win.isVisible(), false);
  c.expand();
  c.panelReady(c.state().motionSequence);
  assert.equal(c.state().transition, '');
  assert.equal(win.isVisible(), true);
});
test('resize uses live pointer coordinates with original minimum sizes', (t) => {
  const { c, win, cursor, tick } = setup(t);
  cursor({ x: 1400, y: 660 });
  c.startWindowResize();
  cursor({ x: 1300, y: 500 });
  tick(32);
  c.endWindowDrag();
  assert.equal(win.getBounds().width, 280);
  assert.equal(win.getBounds().height, 340);
  assert.equal(c.state().edge, null);
});
test('same edge overflow and perpendicular corners never overlap animal surfaces', (t) => {
  const { make } = setup(t);
  const anchors = [];
  for (let i = 0; i < 22; i++) {
    const { c, anchor } = make(
      { edge: i < 2 ? 'top' : 'left', collapsed: true },
      { x: 0, y: 30, width: 340, height: 470 },
    );
    c.setReducedMotion(true);
    c.restore();
    anchors.push(anchor);
  }
  for (let i = 0; i < anchors.length; i++) {
    assert.equal(anchors[i].isVisible(), true);
    const a = anchors[i].getBounds();
    for (let j = 0; j < i; j++) {
      const b = anchors[j].getBounds();
      assert.ok(a.x + 56 <= b.x || b.x + 56 <= a.x || a.y + 56 <= b.y || b.y + 56 <= a.y);
    }
  }
});
test('closing content destroys its companion and persists full dimensions', (t) => {
  const { win, anchor, savedValues } = setup(t);
  win.destroy();
  assert.equal(anchor.isDestroyed(), true);
  assert.equal(savedValues.at(-1).bounds.width, 340);
});

// Moving the companion between edges must not become a free content-window drag.
test('collapsed companion can move from right to top and then left without opening the panel', t => {
 const {c,win,anchor,cursor,tick,ready,display}=setup(t);c.dock();tick(200);
 for(const [target,expected] of [[{x:640,y:display.workArea.y+8},'top'],[{x:8,y:360},'left']]) {
  const start=anchor.getBounds();cursor({x:start.x+28,y:start.y+28});c.startWindowDrag('anchor');
  cursor({x:target.x+28,y:target.y+28});tick(48);assert.equal(c.state().candidateEdge,expected);assert.equal(win.isVisible(),false);
  c.endWindowDrag();assert.equal(c.state().edge,expected);assert.equal(c.state().collapsed,true);assert.equal(anchor.isVisible(),true);assert.equal(anchor.getBounds().width,56);assert.equal(win.isVisible(),false);
 }
 c.expand();ready(c);tick(240);const b=win.getBounds();assert.equal(b.x,display.workArea.x+56+8);assert.equal(b.width,340);
});
test('dragging an expanded companion to a new edge hides the moving panel and restores it beside that edge',t=>{
 const {c,win,anchor,cursor,tick,ready,display}=setup(t);c.dock();tick(200);c.expand();ready(c);tick(240);
 const start=anchor.getBounds();cursor({x:start.x+28,y:start.y+28});c.startWindowDrag('anchor');cursor({x:680,y:display.workArea.y+16});tick(48);assert.equal(win.isVisible(),false);
 c.endWindowDrag();assert.equal(c.state().edge,'top');assert.equal(c.state().transition,'prepare');assert.equal(win.isVisible(),false);ready(c);tick(240);
 assert.equal(win.isVisible(),true);assert.equal(win.getBounds().y,display.workArea.y+56+8);assert.equal(win.getBounds().height,470);
});
