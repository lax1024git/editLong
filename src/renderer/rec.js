const micEl = document.getElementById("mic");
const sysEl = document.getElementById("sys");
const hintEl = document.getElementById("hint");
const tagMic = document.getElementById("tag-mic");
const tagSys = document.getElementById("tag-sys");
const timeEl = document.getElementById("time");
let started = 0;
let timer = null;

function applyState(s) {
  if (!s) return;
  document.body.className = s.phase === "recording" ? "recording" : "setup";
  micEl.checked = !!s.micOn;
  sysEl.checked = !!s.sysOn;
  tagMic.classList.toggle("on", !!s.micOn);
  tagSys.classList.toggle("on", !!s.sysOn);
  const bits = [];
  if (s.micOn) bits.push(s.micDevice ? "麦克风：" + s.micDevice : "麦克风：未检测到设备");
  if (s.sysOn) bits.push(s.sysDevice ? "电脑音频：" + s.sysDevice : "电脑音频：将尝试环回采集");
  if (!bits.length) bits.push("仅录画面，不录声音");
  hintEl.textContent = bits.join("　");
  if (s.phase === "recording") {
    if (!timer) {
      started = Date.now();
      timer = setInterval(tick, 250);
      tick();
    }
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function tick() {
  const sec = Math.floor((Date.now() - started) / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  timeEl.textContent = m + ":" + s;
}

function persist() {
  window.rec.setAudio({ micOn: micEl.checked, sysOn: sysEl.checked });
}

micEl.addEventListener("change", persist);
sysEl.addEventListener("change", persist);
document.getElementById("begin").onclick = () => window.rec.begin();
document.getElementById("cancel").onclick = () => window.rec.cancel();
document.getElementById("stop").onclick = () => window.rec.stop();
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.body.classList.contains("recording")) window.rec.stop();
  else window.rec.cancel();
});

window.rec.onState(applyState);
window.rec.state().then(applyState);
