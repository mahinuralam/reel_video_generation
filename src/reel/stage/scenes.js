// Scene templates. Each takes (root, beat), builds its DOM once and returns update(t), where t is
// seconds since the beat started. Anything with a storyboard "cue" has an "at" time: the moment
// the cue word is spoken.
//
//   checklist  kicker, title, rows that slide in on cue, then all get ticked on the conclusion
//   grid       kicker, title, 2-column tiles that pop in on cue
//   chat       kicker, title, a chat window whose messages type themselves on cue
//   callout    kicker, big warning badge, title, point cards on cue
//
// Overlays (drawn over the avatar on face beats): lower_third, keywords.
(() => {
  const { el, esc, appear, pop, prog, outCubic } = window.A;

  const head = (wrap, d) => {
    const kicker = el("div", "kicker", esc(d.kicker || ""));
    wrap.append(kicker);
    return kicker;
  };

  const SCENES = {};

  SCENES.checklist = (root, beat) => {
    const d = beat.data;
    const wrap = el("div", "content s-checklist");
    const kicker = head(wrap, d);
    const titles = el("div", "titles");
    const t1 = el("div", "title", esc(d.title));
    const t2 = el("div", "title alt", esc(d.conclusion.title));
    titles.append(t1, t2);
    const rows = el("div", "rows");
    const items = d.items.map((it, i) => {
      const row = el("div", "card row");
      const tick = el("div", "tick", icon("check"));
      row.append(el("div", `ic tone${i % 6}`, icon(it.icon)), el("div", "label", esc(it.label)), tick);
      rows.append(row);
      return { row, tick, at: it.at };
    });
    wrap.append(titles, rows);
    root.append(wrap);

    const cAt = d.conclusion.at;
    return (t) => {
      appear(kicker, t, -0.3);
      appear(t1, t, -0.15);
      const out = prog(t, cAt, 0.4);
      if (out > 0) {
        t1.style.opacity = (1 - out).toFixed(3);
        t1.style.transform = `translateY(${(-30 * outCubic(out)).toFixed(2)}px)`;
      }
      appear(t2, t, cAt + 0.15, { dy: 30 });
      items.forEach((it, i) => {
        const tickAt = cAt + 0.4 + i * 0.16;
        appear(it.row, t, it.at, { dx: -60, dy: 0 });
        pop(it.tick, t, tickAt);
        it.row.classList.toggle("done", t >= tickAt);
      });
    };
  };

  SCENES.grid = (root, beat) => {
    const d = beat.data;
    const wrap = el("div", "content s-grid");
    const kicker = head(wrap, d);
    const title = el("div", "title", esc(d.title));
    const grid = el("div", "tiles");
    const tiles = d.items.map((it, i) => {
      const tile = el("div", "card tile");
      tile.append(el("div", `ic tone${i % 6}`, icon(it.icon)), el("div", "label", esc(it.label)));
      grid.append(tile);
      return { tile, at: it.at };
    });
    wrap.append(title, grid);
    root.append(wrap);

    return (t) => {
      appear(kicker, t, -0.3);
      appear(title, t, -0.15);
      tiles.forEach((it) => {
        appear(it.tile, t, it.at, { back: true, scale: 0.8, dy: 30, dur: 0.5 });
        // a short glow while the item is the one being talked about
        const hot = prog(t, it.at, 0.3) * (1 - prog(t, it.at + 0.9, 0.5));
        it.tile.style.borderColor = `rgba(255,255,255,${(0.11 + 0.5 * hot).toFixed(3)})`;
      });
    };
  };

  SCENES.chat = (root, beat) => {
    const d = beat.data;
    const wrap = el("div", "content s-chat");
    const kicker = head(wrap, d);
    const title = el("div", "title", esc(d.title));
    const win = el("div", "card window");
    const bar = el("div", "bar");
    bar.append(el("div", "ic tone1", icon("sparkles")), el("div", "name", "Assistant"),
      el("div", "status", "<i></i>online"));
    const list = el("div", "msgs");
    const msgs = d.messages.map((m) => {
      const b = el("div", `msg ${m.role}`);
      const typed = el("span", "typed"), caret = el("span", "caret"), rest = el("span", "rest", esc(m.text));
      b.append(typed, caret, rest);
      let dots = null;
      if (m.role === "assistant") {
        dots = el("div", "dots", "<i></i><i></i><i></i>");
        b.append(dots);
      }
      list.append(b);
      return { ...m, b, typed, caret, rest, dots };
    });
    win.append(bar, list);
    wrap.append(title, win);
    root.append(wrap);

    return (t) => {
      appear(kicker, t, -0.3);
      appear(title, t, -0.15);
      appear(win, t, 0.1, { dy: 70 });
      msgs.forEach((m) => {
        const think = m.role === "assistant" ? 0.6 : 0.15; // pause before the text starts
        const cps = m.role === "assistant" ? 42 : 30;       // characters typed per second
        appear(m.b, t, m.at, { dy: 24, scale: 0.86, dur: 0.35 });
        const n = Math.max(0, Math.min(m.text.length, Math.floor((t - m.at - think) * cps)));
        m.typed.textContent = m.text.slice(0, n);
        m.rest.textContent = m.text.slice(n);
        const typing = t >= m.at + think && n < m.text.length;
        m.caret.style.opacity = typing ? "1" : "0";
        if (m.dots) {
          const waiting = t >= m.at && t < m.at + think;
          m.dots.style.opacity = waiting ? "1" : "0";
          [...m.dots.children].forEach((dot, i) => {
            dot.style.transform = `translateY(${(-7 * Math.max(0, Math.sin((t - m.at) * 9 - i * 0.9))).toFixed(2)}px)`;
          });
        }
      });
    };
  };

  SCENES.callout = (root, beat) => {
    const d = beat.data;
    const wrap = el("div", "content s-callout");
    const kicker = head(wrap, d);
    const badge = el("div", "badge");
    const rings = [el("div", "ring"), el("div", "ring")];
    const core = el("div", "ic tone-warn", icon(d.icon || "alert"));
    badge.append(...rings, core);
    const title = el("div", "title", esc(d.title));
    const list = el("div", "points");
    const points = d.points.map((p) => {
      const row = el("div", "card point");
      row.append(el("div", `ic tone-${p.tone || "warn"}`, icon(p.icon)), el("div", "label", esc(p.label)));
      list.append(row);
      return { row, at: p.at };
    });
    wrap.append(badge, title, list);
    root.append(wrap);

    const titleAt = d.title_at ?? 0.3;
    return (t) => {
      appear(kicker, t, -0.3);
      pop(core, t, -0.1, 0.55);
      rings.forEach((ring, i) => {
        const phase = (((t - 0.5) * 0.7 + i * 0.5) % 1 + 1) % 1; // repeating outward pulse
        ring.style.transform = `scale(${(1 + phase * 0.55).toFixed(4)})`;
        ring.style.opacity = t < 0.5 ? "0" : ((1 - phase) * 0.55).toFixed(3);
      });
      appear(title, t, titleAt, { back: true, scale: 0.85, dy: 20 });
      points.forEach((p) => appear(p.row, t, p.at, { dx: -60, dy: 0 }));
    };
  };

  const OVERLAYS = {};

  OVERLAYS.lower_third = (root, beat) => {
    const o = beat.overlay;
    const box = el("div", "lower-third");
    const text = el("div");
    text.append(el("div", "lt-title", esc(o.title)), el("div", "lt-sub", esc(o.subtitle || "")));
    box.append(el("div", "bar"), text);
    root.append(box);
    const dur = beat.end - beat.start;
    return (t) => {
      appear(box, t, o.at ?? 0.4, { dx: -80, dy: 0, dur: 0.5 });
      const out = prog(t, dur - 0.4, 0.3);
      if (out > 0) box.style.opacity = (1 - out).toFixed(3);
    };
  };

  OVERLAYS.keywords = (root, beat) => {
    const o = beat.overlay;
    const row = el("div", "keywords");
    const pills = o.items.map((it, i) => {
      const pill = el("div", `pill tone${[0, 1, 2, 3][i % 4]}`, esc(it.label));
      row.append(pill);
      return { pill, at: it.at };
    });
    root.append(row);
    const dur = beat.end - beat.start;
    return (t) => {
      const out = prog(t, dur - 0.5, 0.35);
      pills.forEach((p) => {
        pop(p.pill, t, p.at);
        if (out > 0) p.pill.style.opacity = (1 - out).toFixed(3);
      });
    };
  };

  window.SCENES = SCENES;
  window.OVERLAYS = OVERLAYS;
  // background glow colours per scene (r,g,b)
  window.PALETTES = {
    checklist: ["124,156,255", "94,234,212"],
    grid: ["167,139,250", "244,114,182"],
    chat: ["96,165,250", "167,139,250"],
    callout: ["251,191,36", "248,113,113"],
  };
})();
