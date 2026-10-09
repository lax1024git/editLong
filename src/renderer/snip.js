window.snip.onBackground((url) => {
  document.getElementById("bg").src = url;
});

const params = new URLSearchParams(location.search);
const displayId = Number(params.get("displayId"));
if (params.get("purpose") === "record") {
  document.getElementById("tip").textContent = "拖动选择录屏区域 · Enter 确认 · Esc 取消";
}
const sel = document.getElementById("sel");
const mask = document.getElementById("mask");
const sizeEl = document.getElementById("size");
const tip = document.getElementById("tip");

let start = null;
let rect = null;

function norm(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x);
  const height = Math.abs(b.y - a.y);
  return { x, y, width, height };
}

function paint(r) {
  sel.hidden = false;
  mask.style.background = "transparent";
  sel.style.left = r.x + "px";
  sel.style.top = r.y + "px";
  sel.style.width = r.width + "px";
  sel.style.height = r.height + "px";
  sizeEl.hidden = false;
  sizeEl.textContent = Math.round(r.width) + " × " + Math.round(r.height);
  sizeEl.style.left = r.x + "px";
  sizeEl.style.top = Math.max(0, r.y - 22) + "px";
}

function commit() {
  if (!rect || rect.width < 3 || rect.height < 3) {
    window.snip.cancel();
    return;
  }
  window.snip.done({
    displayId,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    screenX: window.screenX + rect.x,
    screenY: window.screenY + rect.y,
  });
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  tip.hidden = true;
  start = { x: e.clientX, y: e.clientY };
  rect = { x: start.x, y: start.y, width: 0, height: 0 };
  paint(rect);
});

window.addEventListener("mousemove", (e) => {
  if (!start) return;
  rect = norm(start, { x: e.clientX, y: e.clientY });
  paint(rect);
});

window.addEventListener("mouseup", (e) => {
  if (!start || e.button !== 0) return;
  rect = norm(start, { x: e.clientX, y: e.clientY });
  start = null;
  if (rect.width < 3 || rect.height < 3) {
    window.snip.cancel();
    return;
  }
  commit();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.snip.cancel();
  if (e.key === "Enter") commit();
});
