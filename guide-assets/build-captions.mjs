#!/usr/bin/env node
/**
 * Build subtitle PNGs + narration audio, timed to the recorded timeline.
 *
 * Reads timeline.json (written by record-site.mjs) so each caption and voice
 * line lands on the moment the recording actually reached that step.
 *
 *   node build-captions.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG = '/Users/zulhilmi/homebrew/bin/ffmpeg';
const VOICE = 'Samantha';
const OUT = 'captions';

const timeline = JSON.parse(fs.readFileSync('timeline.json', 'utf8'));
const total = timeline.total;
const { width: W, height: H } = timeline;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- script
// Each entry starts at its timeline mark and runs until the next one.
// `say` is what the narrator speaks; `text` is the on-screen caption.
const SCRIPT = [
  {
    at: 'intro',
    say: 'This is WebScrcpy.',
    text: 'WebScrcpy — mirror your phone in the browser',
  },
  {
    at: 'connect',
    say: 'Click Connect, top right.',
    text: 'Click <b>Connect</b> in the top right',
  },
  {
    at: 'nearby',
    say: 'Your phone appears under Nearby.',
    text: 'Your phone appears under <b>Nearby</b> — no IP to type',
  },
  {
    at: 'tap',
    say: 'Tap your phone to connect.',
    text: 'Tap your phone to connect',
  },
  {
    at: 'allow',
    say: 'Then tap Allow on your phone.',
    text: 'Unlock the phone and tap <b>Allow</b>',
  },
  {
    at: 'setup',
    say: 'Setup commands are here, per platform.',
    text: 'Setup commands: <b>macOS</b> and <b>Windows</b> tabs',
  },
  {
    at: 'changelog',
    say: 'Updates are in the changelog.',
    text: 'Every update is listed in the <b>changelog</b>',
  },
  {
    at: 'outro',
    say: 'Unplug and stay wireless.',
    text: 'Unplug the cable and stay wireless',
  },
];

const markTime = (name) => {
  const hit = timeline.marks.find((m) => m.label === name);
  return hit ? hit.t : 0;
};

// ---------------------------------------------------------------- captions
function renderCaption(text, file) {
  const html = fs
    .readFileSync('subtitle.html', 'utf8')
    .replace('__TEXT__', text);
  const tmp = path.join(OUT, '_tmp.html');
  fs.writeFileSync(tmp, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--default-background-color=00000000',
    `--window-size=${W},${H}`,
    `--screenshot=${path.resolve(file)}`,
    `file://${path.resolve(tmp)}`,
  ], { stdio: 'ignore' });
}

// ---------------------------------------------------------------- narration
function narrate(text, file) {
  const aiff = file.replace(/\.wav$/, '.aiff');
  execFileSync('say', ['-v', VOICE, '-r', '180', '-o', aiff, text]);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', aiff, '-ar', '44100', '-ac', '2', file]);
  fs.rmSync(aiff, { force: true });
  const out = execFileSync('/Users/zulhilmi/homebrew/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).toString().trim();
  return Number(out);
}

const segments = [];
for (let i = 0; i < SCRIPT.length; i += 1) {
  const item = SCRIPT[i];
  const start = markTime(item.at);
  const next = SCRIPT[i + 1];
  const end = next ? markTime(next.at) : total;
  const dur = Math.max(end - start, 1.2);
  const png = path.join(OUT, `cap${i}.png`);
  renderCaption(item.text, png);
  const wav = path.join(OUT, `voice${i}.wav`);
  const voiceDur = narrate(item.say, wav);
  segments.push({ i, start, dur, png, wav, voiceDur, at: item.at });
  console.log(
    `${item.at.padEnd(10)} start=${start.toFixed(2)}s  dur=${dur.toFixed(2)}s  voice=${voiceDur.toFixed(2)}s`,
  );
}

fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify(segments, null, 2));
console.log(`\n${segments.length} captions, video ${total.toFixed(1)}s`);
