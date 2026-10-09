const img = document.getElementById("img");
const layer = document.getElementById("layer");
const stage = document.getElementById("stage");
const board = document.getElementById("board");
const zoomLabel = document.getElementById("zoom-label");
const textInput = document.getElementById("text-input");
const colorEl = document.getElementById("color");
const ctx = layer.getContext("2d");

const state = {
  tool: "move",
  color: "#ff3b30",
  size: 6,
  marks: [],
  drawing: null,
  ready: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  panning: false,
  panStart: null,
  lastMouse: { x: 0, y: 0 },
};

function viewScale() {
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  const r = stage.getBoundingClientRect();
  const fit = Math.min(r.width / nw, r.height / nh);
  return fit * state.zoom;
}

function centerView() {
  if (!img.naturalWidth) return;
  const r = stage.getBoundingClientRect();
  const s = viewScale();
  state.panX = (r.width - img.naturalWidth * s) / 2;
  state.panY = (r.height - img.naturalHeight * s) / 2;
}

function applyView() {
  if (!img.naturalWidth) return;
  const s = viewScale();
  board.style.width = img.naturalWidth + "px";
  board.style.height = img.naturalHeight + "px";
  board.style.transform = "translate(" + state.panX + "px," + state.panY + "px) scale(" + s + ")";
  zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
  stage.classList.toggle("fit", Math.abs(state.zoom - 1) < 0.02);
  if (state.tool === "move" && state.zoom > 1.02) layer.style.cursor = "grab";
}

function zoomAt(clientX, clientY, nextZoom) {
  const r = stage.getBoundingClientRect();
  const oldS = viewScale();
  const imgX = (clientX - r.left - state.panX) / oldS;
  const imgY = (clientY - r.top - state.panY) / oldS;
  state.zoom = Math.min(8, Math.max(0.2, nextZoom));
  const newS = viewScale();
  state.panX = clientX - r.left - imgX * newS;
  state.panY = clientY - r.top - imgY * newS;
  applyView();
}

function setTool(tool) {
  commitText();
  state.tool = tool;
  document.querySelectorAll(".tool").forEach((btn) => {
    btn.classList.toggle("active", btn.id === "btn-" + tool);
  });
  stage.classList.toggle("move", tool === "move");
  if (tool === "pen") layer.style.cursor = "crosshair";
  else if (tool === "text") layer.style.cursor = "text";
  else layer.style.cursor = state.zoom > 1.02 ? "grab" : "default";
  applyView();
}

function setSize(size) {
  state.size = size;
  document.querySelectorAll(".size").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.size) === size);
  });
}

function containRect() {
  const r = stage.getBoundingClientRect();
  const s = viewScale();
  return {
    left: r.left + state.panX,
    top: r.top + state.panY,
    w: img.naturalWidth * s,
    h: img.naturalHeight * s,
    scale: s,
  };
}

function toCanvas(e) {
  const box = containRect();
  return {
    x: (e.clientX - box.left) / box.scale,
    y: (e.clientY - box.top) / box.scale,
  };
}

function inImage(pt) {
  return pt.x >= 0 && pt.y >= 0 && pt.x <= layer.width && pt.y <= layer.height;
}

function fontPx() {
  return Math.max(14, state.size * 3.2);
}

function redraw() {
  ctx.clearRect(0, 0, layer.width, layer.height);
  for (const mark of state.marks) drawMark(mark);
  if (state.drawing) drawMark(state.drawing);
}

function drawMark(mark) {
  if (mark.type === "pen") {
    if (!mark.points.length) return;
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = mark.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(mark.points[0].x, mark.points[0].y);
    for (let i = 1; i < mark.points.length; i++) {
      ctx.lineTo(mark.points[i].x, mark.points[i].y);
    }
    if (mark.points.length === 1) {
      ctx.arc(mark.points[0].x, mark.points[0].y, mark.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = mark.color;
      ctx.fill();
      return;
    }
    ctx.stroke();
    return;
  }
  if (mark.type === "text" && mark.text) {
    ctx.fillStyle = mark.color;
    ctx.font = mark.size + "px \"Microsoft YaHei UI\", \"Segoe UI\", sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(mark.text, mark.x, mark.y);
  }
}

function exportDataUrl(format) {
  const out = document.createElement("canvas");
  out.width = img.naturalWidth;
  out.height = img.naturalHeight;
  const g = out.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(img, 0, 0);
  g.drawImage(layer, 0, 0);
  if (format === "jpg") return out.toDataURL("image/jpeg", 0.92);
  return out.toDataURL("image/png");
}

function undo() {
  commitText();
  state.marks.pop();
  redraw();
}

function placeTextInput(pt) {
  const box = containRect();
  textInput.hidden = false;
  textInput.value = "";
  textInput.dataset.x = String(pt.x);
  textInput.dataset.y = String(pt.y);
  textInput.style.color = state.color;
  textInput.style.caretColor = state.color;
  textInput.style.fontSize = fontPx() * box.scale + "px";
  textInput.style.left = box.left + pt.x * box.scale + "px";
  textInput.style.top = box.top + pt.y * box.scale + "px";
  textInput.focus();
}

function commitText() {
  if (textInput.hidden) return;
  const text = textInput.value.trim();
  textInput.hidden = true;
  if (!text) return;
  state.marks.push({
    type: "text",
    text,
    x: Number(textInput.dataset.x),
    y: Number(textInput.dataset.y),
    color: state.color,
    size: fontPx(),
  });
  redraw();
}

function setupImage(url) {
  img.onload = () => {
    layer.width = img.naturalWidth;
    layer.height = img.naturalHeight;
    state.ready = true;
    state.zoom = 1;
    centerView();
    applyView();
    redraw();
  };
  img.src = url;
}

window.pin.onImage(setupImage);

document.getElementById("btn-move").onclick = () => setTool("move");
document.getElementById("btn-pen").onclick = () => setTool("pen");
document.getElementById("btn-text").onclick = () => setTool("text");
document.querySelectorAll(".size").forEach((btn) => {
  btn.onclick = () => setSize(Number(btn.dataset.size));
});
colorEl.oninput = () => {
  state.color = colorEl.value;
};
document.getElementById("btn-undo").onclick = undo;

layer.addEventListener("mousedown", (e) => {
  if (!state.ready || e.button !== 0) return;
  if (state.tool === "move") {
    if (state.zoom <= 1.02) return;
    state.panning = true;
    state.panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    layer.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  const pt = toCanvas(e);
  if (!inImage(pt)) return;
  e.preventDefault();
  if (state.tool === "pen") {
    commitText();
    state.drawing = {
      type: "pen",
      color: state.color,
      width: state.size,
      points: [pt],
    };
    redraw();
  } else if (state.tool === "text") {
    commitText();
    placeTextInput(pt);
  }
});

window.addEventListener("mousemove", (e) => {
  state.lastMouse = { x: e.clientX, y: e.clientY };
  if (state.panning && state.panStart) {
    state.panX = state.panStart.panX + (e.clientX - state.panStart.x);
    state.panY = state.panStart.panY + (e.clientY - state.panStart.y);
    applyView();
    return;
  }
  if (!state.drawing) return;
  const pt = toCanvas(e);
  state.drawing.points.push(pt);
  redraw();
});

window.addEventListener("mouseup", () => {
  if (state.panning) {
    state.panning = false;
    state.panStart = null;
    if (state.tool === "move") layer.style.cursor = state.zoom > 1.02 ? "grab" : "default";
  }
  if (!state.drawing) return;
  if (state.drawing.points.length) state.marks.push(state.drawing);
  state.drawing = null;
  redraw();
});

function applyWheelZoom(deltaY, clientX, clientY) {
  if (!state.ready) return;
  commitText();
  const factor = deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(clientX, clientY, state.zoom * factor);
}

window.addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    applyWheelZoom(e.deltaY, e.clientX, e.clientY);
  },
  { capture: true, passive: false }
);

if (window.pin.onCtrlZoom) {
  window.pin.onCtrlZoom((direction) => {
    const r = stage.getBoundingClientRect();
    const x = state.lastMouse.x || r.left + r.width / 2;
    const y = state.lastMouse.y || r.top + r.height / 2;
    applyWheelZoom(direction === "in" ? -1 : 1, x, y);
  });
}

zoomLabel.onclick = () => {
  if (!state.ready) return;
  state.zoom = 1;
  centerView();
  applyView();
};
zoomLabel.title = "Ctrl+滚轮缩放，点击复位";

textInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    commitText();
  }
  if (e.key === "Escape") {
    textInput.value = "";
    textInput.hidden = true;
  }
});
textInput.addEventListener("blur", () => commitText());

async function save(format) {
  commitText();
  await window.pin.save(format, exportDataUrl(format));
}

document.getElementById("btn-png").onclick = () => save("png");
document.getElementById("btn-jpg").onclick = () => save("jpg");
document.getElementById("btn-copy").onclick = async () => {
  commitText();
  const result = await window.pin.copy(exportDataUrl("png"));
  if (result.ok) {
    const btn = document.getElementById("btn-copy");
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = old;
    }, 800);
  }
};
document.getElementById("btn-close").onclick = () => window.pin.close();

window.addEventListener("keydown", (e) => {
  if (e.target === textInput) return;
  if (e.key === "Escape") {
    if (state.tool !== "move") {
      setTool("move");
      return;
    }
    window.pin.close();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save(e.shiftKey ? "jpg" : "png");
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    e.preventDefault();
    document.getElementById("btn-copy").click();
  }
  if (e.key.toLowerCase() === "p") setTool("pen");
  if (e.key.toLowerCase() === "t") setTool("text");
  if (e.key.toLowerCase() === "m") setTool("move");
  if ((e.ctrlKey || e.metaKey) && (e.key === "0" || e.code === "Digit0" || e.key === "Numpad0")) {
    e.preventDefault();
    state.zoom = 1;
    centerView();
    applyView();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, state.zoom * 1.12);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "-") {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, state.zoom / 1.12);
  }
});

window.addEventListener("resize", () => {
  if (!state.ready) return;
  if (Math.abs(state.zoom - 1) < 0.02) centerView();
  applyView();
});

setTool("move");
setSize(6);
