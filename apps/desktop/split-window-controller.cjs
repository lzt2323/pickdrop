const { screen } = require('electron');
const SIZE = 56,
  GAP = 8,
  EDGES = ['left', 'right', 'top'];
const controllers = new Set();
const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'];
const onDisplaysChanged = () => {
  for (const item of controllers) item.displaysChanged();
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const inside = (p, b, gap = 0) =>
  p.x >= b.x - gap && p.x < b.x + b.width + gap && p.y >= b.y - gap && p.y < b.y + b.height + gap;
function fit(b, display = screen.getDisplayMatching(b)) {
  const a = display.workArea,
    w = clamp(b.width, Math.min(280, a.width), Math.min(900, a.width)),
    h = clamp(b.height, Math.min(340, a.height), Math.min(1100, a.height));
  return {
    x: clamp(Math.round(b.x), a.x, a.x + a.width - w),
    y: clamp(Math.round(b.y), a.y, a.y + a.height - h),
    width: w,
    height: h,
  };
}
function layoutAnchors() {
  const displays = new Map();
  for (const c of controllers) {
    if (!c.docked() || c.anchor.isDestroyed()) continue;
    const d = screen.getDisplayMatching(c.expanded());
    if (!displays.has(d.id)) displays.set(d.id, { area: d.workArea, items: [] });
    displays.get(d.id).items.push(c);
  }
  for (const { area: a, items } of displays.values()) {
    const occupied = [];
    items.sort((x, y) => x.anchor.id - y.anchor.id);
    for (const c of items) {
      const edge = c.edge(),
        top = edge === 'top';
      const start = (top ? a.x : a.y) + SIZE + GAP;
      const end = (top ? a.x + a.width : a.y + a.height) - SIZE - GAP;
      const desired = clamp(
        top ? c.expanded().x + (c.expanded().width - SIZE) / 2 : c.expanded().y,
        start,
        Math.max(start, end),
      );
      const positions = [desired];
      for (let p = start; p <= end; p += SIZE + GAP) positions.push(p);
      positions.sort((x, y) => Math.abs(x - desired) - Math.abs(y - desired));
      let selected = null;
      const depth = top ? a.height : a.width;
      for (let column = 0; column * (SIZE + GAP) + SIZE <= depth && !selected; column++) {
        for (const p of positions) {
          const b = {
            x: top
              ? p
              : edge === 'left'
                ? a.x + column * (SIZE + GAP)
                : a.x + a.width - SIZE - column * (SIZE + GAP),
            y: top ? a.y + column * (SIZE + GAP) : p,
            width: SIZE,
            height: SIZE,
          };
          if (b.x < a.x || b.y < a.y || b.x + SIZE > a.x + a.width || b.y + SIZE > a.y + a.height)
            continue;
          if (
            occupied.some(
              (o) =>
                b.x < o.x + SIZE + GAP &&
                b.x + SIZE + GAP > o.x &&
                b.y < o.y + SIZE + GAP &&
                b.y + SIZE + GAP > o.y,
            )
          )
            continue;
          selected = b;
          break;
        }
      }
      if (selected) {
        occupied.push(selected);
        c.place(selected, a);
      } else c.anchor.hide();
    }
  }
}
function createSplitWindowController(win, anchor, saved, persist) {
  let expanded = fit(win.getBounds()),
    edge = EDGES.includes(saved?.edge) ? saved.edge : null,
    pinned = !!saved?.pinned,
    collapsed = false,
    transition = '',
    duration = 0,
    sequence = 0;
  let closed = false,
    hidden = false,
    drag = null,
    candidate = null,
    focused = true,
    reduced = false,
    uiBusy = false,
    inputBusy = false,
    nativeBusy = false,
    anchorBusy = false,
    dragBusy = false,
    draggingOut = false;
  let focusOnReveal = false;
  let motion,
    hover,
    leave,
    dragTimeout,
    reveal,
    saveTimer,
    blurTimer,
    dragPoll,
    suppress = 0,
    anchorBounds = { x: 0, y: 0, width: SIZE, height: SIZE };
  const alive = () => !closed && !win.isDestroyed() && !anchor.isDestroyed();
  const state = () => ({
    pinned,
    docked: collapsed,
    collapsed,
    edge,
    candidateEdge: candidate,
    moving: !!drag?.moved,
    transition,
    motionDuration: duration,
    accepting: dragBusy,
    contentWidth: expanded.width,
    contentHeight: expanded.height,
    separateAnchor: true,
    tabWindowId: anchor.id,
    contentWindowId: win.id,
    panelVisible: !collapsed || transition === 'collapse',
    motionSequence: sequence,
  });
  const emit = () => {
    if (!alive()) return;
    win.webContents.send('window:changed', state());
    anchor.webContents.send('anchor:state', state());
  };
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist({ bounds: expanded, edge, pinned, collapsed }), 150);
  };
  const busy = () =>
    pinned ||
    uiBusy ||
    inputBusy ||
    nativeBusy ||
    anchorBusy ||
    dragBusy ||
    draggingOut ||
    !!drag ||
    !!transition;
  const setPanel = (b) => {
    suppress = Date.now() + 500;
    win.setBounds(b, false);
  };
  const pointerInside = () => {
    const p = screen.getCursorScreenPoint();
    return (
      (!collapsed && win.isVisible() && inside(p, win.getBounds(), GAP)) ||
      (!!edge && anchor.isVisible() && inside(p, anchorBounds, GAP))
    );
  };
  function stop() {
    clearTimeout(motion);
    motion = null;
    transition = '';
    duration = 0;
    sequence++;
  }
  function scheduleCollapse() {
    clearTimeout(leave);
    if (!edge || collapsed || hidden || busy()) return;
    leave = setTimeout(() => {
      if (alive() && !busy() && !pointerInside()) collapse();
    }, 800);
  }
  function settle() {
    const was = transition;
    stop();
    if (was === 'collapse') {
      win.setIgnoreMouseEvents(true);
      win.hide();
    } else if (was === 'expand') {
      win.setIgnoreMouseEvents(false);
    }
    emit();
    save();
    scheduleCollapse();
  }
  function animate(kind) {
    stop();
    transition = kind;
    duration = reduced || !win.isVisible() ? 0 : kind === 'expand' ? 200 : 160;
    sequence++;
    emit();
    if (!duration) {
      settle();
      return;
    }
    motion = setTimeout(settle, duration);
  }
  function positionPanel(a) {
    const b = { ...expanded };
    if (edge === 'left') {
      b.x = anchorBounds.x + SIZE + GAP;
      b.y = anchorBounds.y;
    }
    if (edge === 'right') {
      b.x = anchorBounds.x - GAP - b.width;
      b.y = anchorBounds.y;
    }
    if (edge === 'top') {
      b.x = anchorBounds.x + (SIZE - b.width) / 2;
      b.y = anchorBounds.y + SIZE + GAP;
    }
    return fit(b, { workArea: a });
  }
  const record = {
    win,
    anchor,
    displaysChanged,
    expanded: () => expanded,
    edge: () => edge,
    docked: () => !!edge && !hidden,
    place: (b, a) => {
      anchorBounds = b;
      anchor.setBounds(b, false);
      if (!hidden) anchor.showInactive();
      if (!collapsed && !drag) {
        const target = positionPanel(a);
        setPanel(target);
      }
    },
  };
  controllers.add(record);
  function prepareReveal(focus = false) {
    stop();
    focusOnReveal = focus;
    collapsed = false;
    transition = 'prepare';
    duration = 0;
    win.setIgnoreMouseEvents(true);
    emit();
    save();
  }
  function panelReady(token) {
    if (!alive() || hidden || transition !== 'prepare' || token !== sequence) return;
    win.setIgnoreMouseEvents(false);
    win.showInactive();
    animate('expand');
    if (focusOnReveal) {
      win.show();
      win.focus();
    }
    focusOnReveal = false;
  }
  function expand(focus = false) {
    clearTimeout(hover);
    hover = null;
    clearTimeout(leave);
    if (!alive()) return state();
    hidden = false;
    if (transition === 'prepare') {
      focusOnReveal ||= focus;
      return state();
    }
    if (collapsed || !win.isVisible()) {
      const reversing = transition === 'collapse' && win.isVisible();
      collapsed = false;
      if (edge) layoutAnchors();
      else setPanel(fit(expanded));
      if (reversing) {
        win.setIgnoreMouseEvents(false);
        animate('expand');
        if (focus) {
          win.show();
          win.focus();
        }
      } else prepareReveal(focus);
    } else {
      if (edge) layoutAnchors();
      if (focus) {
        win.show();
        win.focus();
      }
    }
    return state();
  }
  function collapse(force = false) {
    clearTimeout(hover);
    hover = null;
    clearTimeout(leave);
    if (!edge || collapsed || (!force && busy())) return state();
    collapsed = true;
    layoutAnchors();
    win.setIgnoreMouseEvents(true);
    animate('collapse');
    save();
    return state();
  }
  function edgeFor(b, d = screen.getDisplayMatching(b)) {
    const a = d.workArea,
      dist = { left: b.x - a.x, right: a.x + a.width - b.x - b.width, top: b.y - a.y };
    const near = EDGES.reduce((x, y) => (dist[y] < dist[x] ? y : x), 'left');
    return dist[near] <= 24 ? near : null;
  }
  function dock() {
    if (!alive()) return state();
    if (!edge) {
      expanded = fit(win.getBounds());
      const a = screen.getDisplayMatching(expanded).workArea,
        dist = {
          left: expanded.x - a.x,
          right: a.x + a.width - expanded.x - expanded.width,
          top: expanded.y - a.y,
        };
      edge = EDGES.reduce((x, y) => (dist[y] < dist[x] ? y : x), 'left');
    }
    hidden = false;
    layoutAnchors();
    if (!pinned) collapse(true);
    else {
      collapsed = false;
      win.showInactive();
      emit();
    }
    save();
    return state();
  }
  function pointer(entered, source = 'content') {
    if (drag) return;
    if (entered) {
      clearTimeout(leave);
      if (source === 'anchor' && collapsed && !hover)
        hover = setTimeout(() => {
          hover = null;
          if (alive() && !drag) expand();
        }, 180);
    } else {
      clearTimeout(hover);
      hover = null;
      scheduleCollapse();
    }
  }
  function setBusy(kind, value) {
    if (!alive()) return;
    if (kind === 'anchor-upload') anchorBusy = !!value;
    if (kind === 'ui') uiBusy = focused && !!value;
    if (kind === 'input') inputBusy = focused && !!value;
    if (kind === 'native') nativeBusy = !!value;
    if (busy()) clearTimeout(leave);
    else scheduleCollapse();
  }
  function dragActivity(value) {
    dragBusy = !!value;
    clearTimeout(dragTimeout);
    if (dragBusy) {
      clearTimeout(leave);
      if (collapsed && !reveal)
        reveal = setTimeout(() => {
          reveal = null;
          if (dragBusy && !hidden && alive()) expand();
        }, 120);
      dragTimeout = setTimeout(() => {
        dragBusy = false;
        emit();
        scheduleCollapse();
      }, 1800);
    } else {
      clearTimeout(reveal);
      reveal = null;
      scheduleCollapse();
    }
    emit();
  }
  function startWindowDrag(source = 'content', resizing = false) {
    if (drag || nativeBusy || draggingOut || (resizing && collapsed)) return;
    stop();
    clearTimeout(hover);
    hover = null;
    clearTimeout(leave);
    const fromAnchor = source === 'anchor';
    const bounds = fromAnchor ? anchor.getBounds() : win.getBounds();
    drag = {
      point: screen.getCursorScreenPoint(),
      bounds,
      fromAnchor,
      resizing,
      moved: false,
      wasCollapsed: collapsed,
    };
    dragPoll = setInterval(updateDrag, 16);
    emit();
  }
  function updateDrag() {
    if (!drag || !alive()) return;
    const p = screen.getCursorScreenPoint(),
      dx = p.x - drag.point.x,
      dy = p.y - drag.point.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      if (drag.fromAnchor) {
        // A held icon is the only moving surface. The panel reopens after release.
        collapsed = true;
        win.setIgnoreMouseEvents(true);
        win.hide();
      } else {
        edge = null;
        anchor.hide();
        layoutAnchors();
      }
      emit();
    }
    if (drag.resizing) {
      const a = screen.getDisplayMatching(drag.bounds).workArea;
      expanded = fit(
        {
          ...drag.bounds,
          width: clamp(drag.bounds.width + dx, 280, Math.max(280, a.x + a.width - drag.bounds.x)),
          height: clamp(
            drag.bounds.height + dy,
            340,
            Math.max(340, a.y + a.height - drag.bounds.y),
          ),
        },
        { workArea: a },
      );
      setPanel(expanded);
    } else if (drag.fromAnchor) {
      anchorBounds = {
        ...drag.bounds,
        x: Math.round(drag.bounds.x + dx),
        y: Math.round(drag.bounds.y + dy),
      };
      anchor.setBounds(anchorBounds, false);
      candidate = edgeFor(anchorBounds, screen.getDisplayNearestPoint(p));
      if (!collapsed) {
        const a = screen.getDisplayNearestPoint(p).workArea;
        setPanel(positionPanel(a));
      }
    } else {
      expanded = {
        ...drag.bounds,
        x: Math.round(drag.bounds.x + dx),
        y: Math.round(drag.bounds.y + dy),
      };
      setPanel(expanded);
      candidate = edgeFor(expanded, screen.getDisplayNearestPoint(p));
    }
    emit();
  }
  function endWindowDrag(cancel = false) {
    if (!drag) return;
    if (!cancel) updateDrag();
    const d = drag;
    drag = null;
    clearInterval(dragPoll);
    dragPoll = null;
    candidate = null;
    if (d.moved) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (d.fromAnchor) {
        if (cancel) {
          anchorBounds = d.bounds;
          anchor.setBounds(anchorBounds, false);
          layoutAnchors();
          if (!d.wasCollapsed || pinned) prepareReveal();
        } else {
          const originalEdge = edge;
          edge = edgeFor(anchorBounds, display);
          const placementEdge = edge || originalEdge;
          anchor.hide();
          expanded = fit(
            {
              ...expanded,
              x:
                placementEdge === 'right'
                  ? anchorBounds.x + SIZE - expanded.width
                  : placementEdge === 'top'
                    ? anchorBounds.x + (SIZE - expanded.width) / 2
                    : anchorBounds.x,
              y: anchorBounds.y,
            },
            display,
          );
          if (edge) {
            // Reattach on the destination edge rather than opening a free window.
            layoutAnchors();
            setPanel(positionPanel(display.workArea));
            if (!d.wasCollapsed || pinned) prepareReveal();
          } else {
            setPanel(expanded);
            prepareReveal();
            layoutAnchors();
          }
        }
      } else {
        expanded = fit(win.getBounds(), display);
        edge = cancel || d.resizing ? null : edgeFor(win.getBounds(), display);
        setPanel(expanded);
        if (edge) layoutAnchors();
      }
    }
    emit();
    save();
    scheduleCollapse();
  }
  function hide() {
    endWindowDrag(true);
    hidden = true;
    stop();
    clearTimeout(reveal);
    reveal = null;
    clearTimeout(dragTimeout);
    dragBusy = false;
    clearTimeout(hover);
    hover = null;
    clearTimeout(leave);
    anchor.hide();
    win.setIgnoreMouseEvents(true);
    win.hide();
    layoutAnchors();
    save();
  }
  function displaysChanged() {
    if (!alive()) return;
    endWindowDrag(true);
    expanded = fit(expanded);
    if (edge) layoutAnchors();
    else if (!collapsed) setPanel(expanded);
    emit();
    save();
  }
  win.on('move', () => {
    if (!alive() || Date.now() < suppress || drag || collapsed || transition) return;
    expanded = fit(win.getBounds());
    if (edge) {
      edge = null;
      anchor.hide();
      layoutAnchors();
    }
    save();
    emit();
  });
  win.on('resize', () => {
    if (!alive() || Date.now() < suppress || drag || collapsed || transition) return;
    expanded = fit(win.getBounds());
    save();
    emit();
  });
  win.on('blur', () => {
    focused = false;
    uiBusy = false;
    inputBusy = false;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (drag && !anchor.isFocused?.()) endWindowDrag(true);
      scheduleCollapse();
    }, 60);
  });
  win.on('hide', () => {
    if (!hidden && !collapsed) hide();
  });
  anchor.on('closed', () => {
    if (!win.isDestroyed()) win.destroy();
  });
  win.on('focus', () => {
    focused = true;
    clearTimeout(blurTimer);
  });
  anchor.on('blur', () => {
    if (drag?.fromAnchor) {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => endWindowDrag(true), 60);
    }
  });
  anchor.on('focus', () => clearTimeout(blurTimer));
  let wasInside = false;
  const poll = setInterval(() => {
    if (!alive() || hidden) return;
    const now = pointerInside();
    if (now !== wasInside) {
      wasInside = now;
      pointer(now, collapsed ? 'anchor' : 'content');
    }
  }, 100);
  if (controllers.size === 1) for (const name of DISPLAY_EVENTS) screen.on(name, onDisplaysChanged);
  win.on('closed', () => {
    closed = true;
    controllers.delete(record);
    stop();
    clearInterval(poll);
    clearInterval(dragPoll);
    [hover, leave, dragTimeout, reveal, saveTimer, blurTimer].forEach(clearTimeout);
    if (!controllers.size)
      for (const name of DISPLAY_EVENTS) screen.removeListener(name, onDisplaysChanged);
    if (!anchor.isDestroyed()) anchor.destroy();
    layoutAnchors();
    persist({ bounds: expanded, edge, pinned, collapsed });
  });
  return {
    state,
    emit,
    panelReady,
    expand,
    collapse,
    dock,
    hide,
    restore() {
      if (edge) {
        layoutAnchors();
        if (saved?.collapsed && !pinned) collapse(true);
      }
      emit();
    },
    setPinned(v) {
      pinned = !!v;
      if (pinned) expand();
      else scheduleCollapse();
      emit();
      save();
      return state();
    },
    setBusy,
    pointer,
    dragActivity,
    nativeDragStart() {
      draggingOut = true;
      expand();
      clearTimeout(leave);
    },
    nativeDragEnd() {
      draggingOut = false;
      scheduleCollapse();
    },
    startWindowDrag,
    startWindowResize() {
      startWindowDrag('content', true);
    },
    endWindowDrag,
    setReducedMotion(v) {
      reduced = !!v;
      if (reduced && transition) {
        if (transition === 'prepare') panelReady(sequence);
        else settle();
      }
    },
    settleMotion: settle,
  };
}
module.exports = { createSplitWindowController };
