'use strict';

/* Synthesized chiptune audio (Web Audio API, no asset files). The context is
   created on the first user gesture; sfx() calls before that are ignored.
   sfx(name, x) pans by world x relative to the camera and is rate-limited per
   name so multi-hit moves do not stack dozens of voices. */

const AUDIO_PREFS_KEY = 'neon-clash-audio-v1';
const audio = {
  ctx: null, master: null, sfxBus: null, musicBus: null, noise: null,
  sfxOn: true, musicOn: true, volume: 0.7,
  last: Object.create(null), voices: 0,
  seqTimer: null, seqStep: 0, seqTime: 0, seqPlaying: false, seqIntensity: 0,
};

(function loadAudioPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(AUDIO_PREFS_KEY) || 'null');
    if (p && typeof p === 'object') {
      if (typeof p.sfxOn === 'boolean') audio.sfxOn = p.sfxOn;
      if (typeof p.musicOn === 'boolean') audio.musicOn = p.musicOn;
      if (typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1) audio.volume = p.volume;
    }
  } catch (err) { /* storage unavailable: defaults */ }
})();

function saveAudioPrefs() {
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify({ sfxOn: audio.sfxOn, musicOn: audio.musicOn, volume: audio.volume })); } catch (err) { /* storage unavailable */ }
}

function audioUnlock() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC({ latencyHint: 'interactive' });
  audio.ctx = ctx;
  audio.master = ctx.createGain();
  audio.master.gain.value = audio.volume;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  audio.master.connect(comp).connect(ctx.destination);
  audio.sfxBus = ctx.createGain(); audio.sfxBus.gain.value = audio.sfxOn ? 1 : 0; audio.sfxBus.connect(audio.master);
  audio.musicBus = ctx.createGain(); audio.musicBus.gain.value = audio.musicOn ? 0.32 : 0; audio.musicBus.connect(audio.master);
  const len = ctx.sampleRate;
  audio.noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = audio.noise.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  if (audio.seqPlaying) startSequencer();
}

function setAudioVolume(v) { audio.volume = v; if (audio.master) audio.master.gain.value = v; saveAudioPrefs(); }
function setSfxOn(on) { audio.sfxOn = on; if (audio.sfxBus) audio.sfxBus.gain.value = on ? 1 : 0; saveAudioPrefs(); }
function setMusicOn(on) { audio.musicOn = on; if (audio.musicBus) audio.musicBus.gain.value = on ? 0.32 : 0; saveAudioPrefs(); }

function panFor(x) {
  if (x === undefined || x === null) return 0;
  return clamp(((x - game.camX) - W / 2) / (W / 2), -1, 1) * 0.6;
}

function voiceOut(bus, pan, t, dur) {
  const ctx = audio.ctx;
  const g = ctx.createGain();
  let node = g;
  if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
  node.connect(bus);
  audio.voices++;
  setTimeout(() => { audio.voices--; }, (dur + 0.1) * 1000);
  return g;
}

/* Oscillator with an exponential pitch sweep and a percussive envelope. */
function tone(type, f0, f1, dur, vol, pan, delay, bus) {
  const ctx = audio.ctx, t = ctx.currentTime + (delay || 0);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, f0), t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = voiceOut(bus || audio.sfxBus, pan, t, dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  osc.start(t); osc.stop(t + dur + 0.02);
}

/* Filtered white noise burst; the filter cutoff sweeps from c0 to c1. */
function noise(dur, vol, type, c0, c1, pan, delay, bus) {
  const ctx = audio.ctx, t = ctx.currentTime + (delay || 0);
  const src = ctx.createBufferSource();
  src.buffer = audio.noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type; f.Q.value = type === 'bandpass' ? 2 : 0.7;
  f.frequency.setValueAtTime(c0, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(30, c1), t + dur);
  const g = voiceOut(bus || audio.sfxBus, pan, t, dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
}

const SFX_GAP = { jab: 0.03, kick: 0.03, hit: 0.03, heavy: 0.05, block: 0.04, fire: 0.08, status: 0.12, bullet: 0.05, whiff: 0.04, land: 0.06, heal: 0.2 };

function sfx(name, x) {
  const ctx = audio.ctx;
  if (!ctx || !audio.sfxOn || ctx.state !== 'running' || audio.voices > 48) return;
  const now = ctx.currentTime, gap = SFX_GAP[name] || 0.015;
  if (audio.last[name] !== undefined && now - audio.last[name] < gap) return;
  audio.last[name] = now;
  const p = panFor(x);
  switch (name) {
    case 'whiff': noise(0.07, 0.12, 'bandpass', 1800, 600, p); break;
    case 'jab': noise(0.05, 0.35, 'highpass', 2400, 1200, p); tone('square', 260, 110, 0.05, 0.18, p); break;
    case 'kick': noise(0.09, 0.4, 'lowpass', 1600, 400, p); tone('square', 170, 60, 0.09, 0.22, p); break;
    case 'heavy': noise(0.2, 0.55, 'lowpass', 1800, 150, p); tone('triangle', 110, 38, 0.22, 0.45, p); tone('square', 70, 40, 0.12, 0.15, p); break;
    case 'block': tone('square', 1100, 800, 0.05, 0.14, p); noise(0.04, 0.2, 'highpass', 5000, 3000, p); break;
    case 'guardbreak': tone('square', 700, 120, 0.35, 0.25, p); noise(0.3, 0.3, 'bandpass', 3000, 300, p); break;
    case 'parry': tone('square', 1400, 2100, 0.1, 0.2, p); tone('sine', 2100, 2100, 0.25, 0.15, p, 0.06); break;
    case 'grab': tone('sawtooth', 200, 80, 0.16, 0.22, p); noise(0.12, 0.3, 'lowpass', 900, 200, p, 0.08); break;
    case 'jump': tone('square', 280, 620, 0.09, 0.1, p); break;
    case 'dash': noise(0.13, 0.25, 'bandpass', 700, 2600, p); break;
    case 'land': noise(0.07, 0.25, 'lowpass', 500, 120, p); break;
    case 'skill': tone('square', 440, 880, 0.08, 0.14, p); tone('square', 660, 1320, 0.08, 0.1, p, 0.06); break;
    case 'ult':
      tone('sawtooth', 110, 880, 0.6, 0.25, p); tone('square', 220, 1760, 0.6, 0.12, p, 0.05);
      noise(0.7, 0.2, 'bandpass', 400, 4000, p); break;
    case 'burst': noise(0.3, 0.45, 'lowpass', 3000, 200, p); tone('square', 90, 900, 0.25, 0.2, p); break;
    case 'bolt': tone('sawtooth', 1200, 300, 0.14, 0.18, p); noise(0.1, 0.18, 'highpass', 6000, 3000, p); break;
    case 'wave': tone('sine', 300, 1400, 0.18, 0.2, p); tone('triangle', 600, 2400, 0.12, 0.08, p); break;
    case 'hack': for (let i = 0; i < 4; i++) tone('square', 900 + ((i * 7) % 5) * 220, 900 + ((i * 7) % 5) * 220, 0.035, 0.1, p, i * 0.04); break;
    case 'spit': noise(0.12, 0.3, 'lowpass', 900, 200, p); tone('sine', 320, 140, 0.12, 0.15, p); break;
    case 'grenade': tone('square', 520, 260, 0.1, 0.12, p); break;
    case 'quake': noise(0.5, 0.6, 'lowpass', 500, 60, p); tone('triangle', 70, 28, 0.5, 0.5, p); break;
    case 'bullet': tone('square', 1500, 900, 0.035, 0.08, p); break;
    case 'explode': noise(0.4, 0.6, 'lowpass', 1400, 80, p); tone('triangle', 90, 30, 0.35, 0.4, p); break;
    case 'zap': noise(0.28, 0.45, 'highpass', 5000, 800, p); tone('sawtooth', 1600, 90, 0.3, 0.22, p); break;
    case 'fire': noise(0.3, 0.35, 'bandpass', 1200, 400, p); break;
    case 'status': tone('triangle', 660, 520, 0.06, 0.08, p); break;
    case 'heal': for (let i = 0; i < 3; i++) tone('sine', 660 * (1 + i * 0.25), 660 * (1 + i * 0.25), 0.08, 0.1, p, i * 0.06); break;
    case 'crash': for (let i = 0; i < 8; i++) tone('square', 200 + ((i * 13) % 7) * 180, 100, 0.06, 0.12, p, i * 0.03); noise(0.4, 0.3, 'bandpass', 2000, 300, p); break;
    case 'round': tone('square', 523, 523, 0.14, 0.16, 0); tone('square', 784, 784, 0.22, 0.16, 0, 0.16); break;
    case 'fight': tone('square', 523, 523, 0.08, 0.16, 0); tone('square', 659, 659, 0.08, 0.16, 0, 0.09); tone('square', 1046, 1046, 0.3, 0.2, 0, 0.18); break;
    case 'ko': tone('sawtooth', 440, 55, 0.9, 0.3, 0); noise(0.8, 0.35, 'lowpass', 2000, 60, 0); break;
    case 'win': [523, 659, 784, 1046].forEach((f, i) => tone('square', f, f, 0.14, 0.14, 0, i * 0.12)); break;
    case 'ui': tone('square', 880, 880, 0.03, 0.08, 0); break;
    case 'tick': tone('square', 1320, 1320, 0.025, 0.06, 0); break;
    case 'lock': tone('square', 660, 660, 0.07, 0.14, 0); tone('square', 990, 990, 0.16, 0.14, 0, 0.08); break;
  }
}

/* 16-step chiptune loop: triangle bass, square lead, noise hats and a kick.
   seqIntensity 0 = menu (bass and hats only), 1 = fight (full arrangement). */
const SEQ_BPM = 136;
const BASS = [45, 0, 45, 57, 0, 45, 55, 0, 43, 0, 43, 55, 0, 43, 52, 0, 41, 0, 41, 53, 0, 41, 52, 0, 40, 0, 40, 52, 47, 0, 52, 0];
const LEAD = [69, 0, 72, 0, 76, 74, 72, 0, 67, 0, 71, 0, 74, 72, 71, 0, 65, 0, 69, 0, 72, 71, 69, 0, 64, 0, 68, 71, 76, 0, 74, 72];
function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

function startSequencer() {
  if (!audio.ctx || audio.seqTimer) return;
  audio.seqTime = audio.ctx.currentTime + 0.05;
  audio.seqTimer = setInterval(() => {
    const ctx = audio.ctx;
    const stepDur = 60 / SEQ_BPM / 4;
    while (audio.seqTime < ctx.currentTime + 0.12) {
      const s = audio.seqStep % 32, d = audio.seqTime - ctx.currentTime;
      if (BASS[s]) tone('triangle', midi(BASS[s]), midi(BASS[s]), stepDur * 1.6, 0.35, 0, d, audio.musicBus);
      if (s % 2 === 0) noise(0.03, 0.12, 'highpass', 7000, 6000, 0, d, audio.musicBus);
      if (audio.seqIntensity > 0) {
        if (LEAD[s]) tone('square', midi(LEAD[s]), midi(LEAD[s]), stepDur * 1.2, 0.07, 0, d, audio.musicBus);
        if (s % 8 === 0) tone('sine', 120, 45, 0.12, 0.5, 0, d, audio.musicBus);
        if (s % 8 === 4) noise(0.09, 0.2, 'bandpass', 1800, 900, 0, d, audio.musicBus);
      }
      audio.seqTime += stepDur; audio.seqStep++;
    }
  }, 25);
}

function playMusic(intensity) {
  audio.seqPlaying = true;
  audio.seqIntensity = intensity;
  startSequencer();
}
