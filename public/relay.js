/* Relay: publish a shared or mirrored window as frames under a short code. */
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
let code = (params.get('code') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
if (code.length < 4) code = Math.random().toString(36).slice(2, 8);
$('code').textContent = code;

$('code').title = 'Click to change';
$('code').style.cursor = 'pointer';
$('code').onclick = () => {
  const next = prompt('Relay code (4–12 letters or digits):', code);
  if (!next) return;
  const clean = next.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  if (clean.length < 4) return alert('Use at least 4 characters.');
  code = clean;
  $('code').textContent = code;
  history.replaceState(null, '', '?code=' + code);
};

let stream = null;
let timer = null;
let frames = 0;
let inFlight = false;
const video = $('src');
const canvas = document.createElement('canvas');

function toJpeg(source, maxWidth = 1280, quality = 0.7) {
  const w = source.videoWidth || 0;
  const h = source.videoHeight || 0;
  if (!w || !h) return null;
  const scale = Math.min(1, maxWidth / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function sendFrame() {
  if (inFlight || !stream) return;
  const image = toJpeg(video);
  if (!image) return;
  inFlight = true;
  try {
    const headers = { 'content-type': 'application/json' };
    const access = params.get('access') || localStorage.getItem('sage.access') || '';
    if (access) headers['x-access-code'] = access;
    const res = await fetch('/api/relay/' + code + '/frame', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'HTTP ' + res.status);
    frames = data.frames || frames + 1;
    $('statFrames').textContent = String(frames);
    $('statStatus').textContent = 'live';
    $('statError').textContent = '';
    const preview = $('preview');
    let img = preview.querySelector('img');
    if (!img) {
      preview.innerHTML = '';
      img = document.createElement('img');
      preview.appendChild(img);
    }
    img.src = image;
  } catch (error) {
    $('statError').textContent = 'Send failed: ' + error.message;
    $('statStatus').textContent = 'error';
  } finally {
    inFlight = false;
  }
}

async function start() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('statError').textContent = 'This browser cannot capture a screen. Use Chrome or Edge on a computer.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
  } catch (error) {
    if (error.name !== 'NotAllowedError') $('statError').textContent = error.message;
    return;
  }
  video.srcObject = stream;
  video.play().catch(() => {});
  stream.getVideoTracks()[0].addEventListener('ended', stop);

  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('statStatus').textContent = 'starting';
  const interval = Number($('rate').value) || 3000;
  clearInterval(timer);
  timer = setInterval(sendFrame, interval);
  setTimeout(sendFrame, 500);
}

function stop() {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  $('statStatus').textContent = 'stopped';
}

$('btnStart').onclick = start;
$('btnStop').onclick = stop;
$('rate').onchange = () => {
  if (!stream) return;
  clearInterval(timer);
  timer = setInterval(sendFrame, Number($('rate').value) || 3000);
};

window.addEventListener('beforeunload', stop);
