// Small animation helpers. Everything is a function of time `t` (seconds), never of wall-clock time.
window.A = (() => {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const outCubic = (x) => 1 - Math.pow(1 - x, 3);
  const outBack = (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };
  // 0 before `at`, 1 once `dur` seconds have passed
  const prog = (t, at, dur) => clamp01((t - at) / dur);

  // Fade + slide + slight grow, starting at time `at`.
  function appear(el, t, at, o = {}) {
    const dur = o.dur ?? 0.5, dy = o.dy ?? 40, dx = o.dx ?? 0, s0 = o.scale ?? 0.94;
    const p = prog(t, at, dur);
    const e = (o.back ? outBack : outCubic)(p);
    el.style.opacity = clamp01(p * 2.5).toFixed(3);
    el.style.transform =
      `translate(${((1 - e) * dx).toFixed(2)}px, ${((1 - e) * dy).toFixed(2)}px) scale(${(s0 + (1 - s0) * e).toFixed(4)})`;
  }

  // Pop from nothing with a small overshoot.
  function pop(el, t, at, dur = 0.45) {
    const p = prog(t, at, dur);
    el.style.opacity = clamp01(p * 3).toFixed(3);
    el.style.transform = `scale(${(p <= 0 ? 0 : outBack(p)).toFixed(4)})`;
  }

  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  return { clamp01, outCubic, outBack, prog, appear, pop, el, esc };
})();
