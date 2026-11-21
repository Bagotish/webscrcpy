#!/usr/bin/env node
/**
 * Compose the final walkthrough: real screen footage + caption overlays +
 * narration, with fades and gentle push-in on the opening shot.
 *
 *   node compose-site.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = '/Users/zulhilmi/homebrew/bin/ffmpeg';
const FFPROBE = '/Users/zulhilmi/homebrew/bin/ffprobe';
const OUT = '../WebScrcpy-Wireless-Guide.mp4';

const timeline = JSON.parse(fs.readFileSync('timeline.json', 'utf8'));
const segments = JSON.parse(fs.readFileSync('captions/segments.json', 'utf8'));
const total = timeline.total;

// ---------------------------------------------------------------- video input
// Screencast frames arrive on change, so the rate is not constant. Use the
// measured average so the frame stream lines up with the timeline seconds.
const frames = fs.readdirSync('frames').filter((f) => f.endsWith('.jpg')).sort();
if (!frames.length) throw new Error('no frames — run record-site.mjs first');
const FPS = frames.length / total;
console.log(`frames: ${frames.length} over ${total.toFixed(1)}s → ${FPS.toFixed(2)}fps`);

const lastVoiceEnd = segments.reduce(
  (max, s) => Math.max(max, s.start + s.voiceDur + 0.9), 0,
);
const holdTail = Math.max(0, lastVoiceEnd - frames.length / FPS);
console.log(`tail hold: ${holdTail.toFixed(2)}s`);

// ---------------------------------------------------------------- filtergraph
const inputs = ['-framerate', FPS.toFixed(4), '-i', 'frames/%05d.jpg'];
const filters = [];

// Base: fit the 16:10 capture inside 1920x1080 on a dark backdrop.
filters.push(
  `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,` +
  `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x09090b,` +
  `tpad=stop_mode=clone:stop_duration=${holdTail.toFixed(2)},` +
  `fps=30,format=rgba[base]`,
);

let current = 'base';
let inputIndex = 1;

for (let i = 0; i < segments.length; i += 1) {
  const s = segments[i];
  const enable = `between(t,${s.start.toFixed(3)},${(s.start + s.dur).toFixed(3)})`;
  if (!fs.existsSync(s.png)) throw new Error(`missing caption image: ${s.png}`);

  // Caption overlay, faded in/out.
  inputs.push('-loop', '1', '-framerate', '30', '-i', s.png);
  filters.push(`[${inputIndex}:v]format=rgba,fade=t=in:st=0:d=0.18:alpha=1[cap${i}]`);
  inputIndex += 1;

  const out = `v${i}`;
  filters.push(
    `[${current}][cap${i}]overlay=0:0:enable='${enable}':format=auto[${out}]`,
  );
  current = out;
}

// Fade the whole video in and out.
filters.push(
  `[${current}]fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0, total - 0.6).toFixed(2)}:d=0.6,` +
  `format=yuv420p[vout]`,
);

// ---------------------------------------------------------------- audio
const voiceInputs = [];
for (const s of segments) {
  inputs.push('-i', s.wav);
  voiceInputs.push(inputIndex);
  inputIndex += 1;
}

const mixParts = [];
voiceInputs.forEach((idx, n) => {
  const s = segments[n];
  const delayMs = Math.round(s.start * 1000);
  filters.push(`[${idx}:a]adelay=${delayMs}|${delayMs},apad,atrim=0:${(total + 2).toFixed(2)}[a${n}]`);
  mixParts.push(`[a${n}]`);
});
filters.push(
  `${mixParts.join('')}amix=inputs=${mixParts.length}:duration=longest:normalize=0,` +
  `alimiter=limit=0.95,afade=t=out:st=${Math.max(0, total - 1).toFixed(2)}:d=1[aout]`,
);

const args = [
  '-hide_banner', '-loglevel', 'error', '-y',
  ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  '-t', String((total + 0.8).toFixed(2)),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
  '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
  '-movflags', '+faststart',
  OUT,
];

console.log('encoding…');
execFileSync(FFMPEG, args, { stdio: 'inherit' });

const probe = execFileSync(FFPROBE, [
  '-v', 'error', '-show_entries', 'format=duration,size',
  '-of', 'default=nw=1', OUT,
]).toString();
console.log(probe.trim());
