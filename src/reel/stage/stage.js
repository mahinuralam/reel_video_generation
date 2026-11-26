// Stage controller: Stage.init(timeline, beatId) builds one beat; Stage.render(t) draws the frame
// at global time t (seconds from the start of the reel).
(() => {
  const { el, esc, prog, outCubic } = window.A;
  const $ = (id) => document.getElementById(id);

  let TL = null, beat = null, isFace = false, isSplit = false;
  let updateScene = null, updateOverlay = null;
  let capEl = null, capChunk = null, capSpans = [];
  let progressFill = null, palette = null;

  async function init(timeline, beatId) {
    TL = timeline;
    beat = TL.beats.find((b) => b.id === beatId);
    if (!beat) throw new Error(`no beat '${beatId}' in timeline`);
    isFace = beat.type === "face";
    isSplit = beat.type === "split";
    document.body.classList.toggle("face", isFace);
    document.body.classList.toggle("split", isSplit);
    for (const id of ["header", "scene", "overlay", "captions"]) $(id).innerHTML = "";
    updateScene = updateOverlay = null;
    capChunk = null;

    if (isFace) {
      if (beat.overlay) {
        const make = window.OVERLAYS[beat.overlay.kind];
        if (!make) throw new Error(`unknown overlay '${beat.overlay.kind}'`);
        updateOverlay = make($("overlay"), beat);
      }
    } else {
      const make = window.SCENES[beat.scene];
      if (!make) throw new Error(`unknown scene '${beat.scene}'`);
      palette = window.PALETTES[beat.scene] || window.PALETTES.checklist;
      const hdr = el("div", "hdr", `<span class="dot"></span><span class="topic">${esc(TL.topic || "")}</span>`);
      const bar = el("div", "progress");
      progressFill = el("i");
      bar.append(progressFill);
      $("header").append(hdr, bar);
      updateScene = make($("scene"), beat);
    }

    capEl = el("div", "cap");
    $("captions").append(capEl);

    await document.fonts.load('800 68px "Inter"');
    await document.fonts.ready;
    if (isSplit) fitTop();
    return document.fonts.check('800 68px "Inter"');
  }

  // Split beats: shrink the scene into the top half (y 80-860), above the avatar.
  function fitTop() {
    const content = $("scene").firstElementChild;
    const top = content.offsetTop, h = content.offsetHeight;
    const s = Math.min(0.92, 780 / h);
    $("scene").style.transformOrigin = "540px 0";
    $("scene").style.transform = `translateY(${(80 - top * s).toFixed(1)}px) scale(${s.toFixed(4)})`;
  }

  function drawBackground(tG) {
    const a = tG * 0.2;
    const x1 = 540 + 380 * Math.cos(a), y1 = 520 + 260 * Math.sin(a * 1.3);
    const x2 = 540 - 400 * Math.cos(a * 0.8 + 1), y2 = 1400 + 220 * Math.sin(a + 2);
    $("bg").style.background =
      `radial-gradient(760px 760px at ${x1.toFixed(1)}px ${y1.toFixed(1)}px, rgba(${palette[0]},0.30), transparent 70%),` +
      `radial-gradient(680px 680px at ${x2.toFixed(1)}px ${y2.toFixed(1)}px, rgba(${palette[1]},0.20), transparent 70%),` +
      `linear-gradient(180deg, #0a0f1f 0%, #111a3a 55%, #0b1022 100%)`;
  }

  function drawCaptions(tG) {
    const chunk = TL.captions.find((c) => tG >= c.s && tG < c.e);
    if (!chunk) {
      capEl.style.opacity = "0";
      capChunk = null;
      return;
    }
    if (chunk !== capChunk) {
      capChunk = chunk;
      capEl.innerHTML = "";
      capSpans = chunk.words.map((w) => {
        const span = el("span", "w", esc(w.w));
        capEl.append(span);
        return span;
      });
    }
    chunk.words.forEach((w, i) => {
      const next = chunk.words[i + 1];
      const on = tG >= w.s && (!next || tG < next.s);
      capSpans[i].classList.toggle("on", on);
      capSpans[i].style.transform = on ? "scale(1.04)" : "scale(1)";
    });
    capEl.style.opacity = "1";
    capEl.style.transform = `scale(${(0.9 + 0.1 * outCubic(prog(tG, chunk.s, 0.14))).toFixed(4)})`;
  }

  function render(tG) {
    const t = tG - beat.start;
    if (isFace) {
      if (updateOverlay) updateOverlay(t, tG);
    } else {
      drawBackground(tG);
      progressFill.style.width = `${(100 * Math.min(1, tG / (TL.total_frames / TL.fps))).toFixed(2)}%`;
      updateScene(t, tG);
    }
    drawCaptions(tG);
  }

  window.Stage = { init, render };
})();
