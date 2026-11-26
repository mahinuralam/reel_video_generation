// Line icons on a 24x24 grid, drawn for this project. Use a name from this list in a storyboard.
window.ICONS = {
  chat: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M9.8 9.3a2.3 2.3 0 1 1 3.3 2.1c-.7.3-1.1.8-1.1 1.4 M12 14.9h.01",
  bulb: "M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z",
  pencil: "M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z M14.5 6.5l3 3",
  sparkles: "M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7-4.7-1.8 4.7-1.8L11 3z M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z",
  cap: "M2 9l10-5 10 5-10 5-10-5z M6 11.5V16c0 1.2 2.7 2.5 6 2.5s6-1.3 6-2.5v-4.5 M22 9v6",
  mail: "M3 6h18v12H3z M3 7l9 6 9-6",
  doc: "M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6",
  target: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0z M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M3 12h18 M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.500 5.500 12 3z",
  code: "M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 5l-3 14",
  alert: "M12 4L2.5 20h19L12 4z M12 10v5 M12 17.600h.01",
  check: "M4.5 12.500l5 5 10-11",
  shield: "M12 3l8 3v6c0 4.500-3.200 7.800-8 9-4.800-1.200-8-4.500-8-9V6l8-3z M8.500 12l2.500 2.500 4.500-5",
  star: "M12 3l2.700 5.700 6.300.800-4.600 4.300 1.200 6.200L12 17l-5.600 3 1.200-6.200L3 9.500l6.300-.800L12 3z",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 7v5l3.500 2",
  rocket: "M5 19l2.500-6.500C9 8 12.500 4.500 19 4c-.500 6.500-4 10-8.500 11.500L5 19z M9 13l2 2 M14.500 9.500h.01",
};

window.icon = (name) => {
  const d = window.ICONS[name] || window.ICONS.star;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
};
