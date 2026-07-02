// Extract FENs from a clone of melvincarvalho/endgames, classify each with
// native stockfish, emit positions.json for the trainer.
//
// Usage: node tools/extract-positions.js /path/to/endgames/docs
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateFen, Chess } = require('../node_modules/chess.js/dist/cjs/chess.js');

const DOCS = process.argv[2];
if (!DOCS) { console.error('usage: node tools/extract-positions.js <endgames>/docs'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'positions.json');

const catName = (dir) =>
  dir.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace('Vs', 'vs');

// walk docs/*/*.md
const entries = [];
for (const dir of fs.readdirSync(DOCS)) {
  const full = path.join(DOCS, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(full, file), 'utf8');
    const pageTitle = (text.match(/^# (.+)$/m) || [])[1] || file.replace('.md', '');
    // scan line by line, remembering the nearest heading and component titles
    let heading = pageTitle;
    let componentTitle = null;
    for (const line of text.split('\n')) {
      const h = line.match(/^#{2,4} (.+)$/);
      if (h) { heading = h[1].trim(); componentTitle = null; continue; }
      const t = line.match(/^\s*title="([^"]+)"/);
      if (t) componentTitle = t[1];
      const f = line.match(/fen="([^"]+)"/);
      if (f) {
        entries.push({
          fen: f[1].trim(),
          name: (componentTitle || heading).replace(/^Puzzle \d+: /, ''),
          category: catName(dir),
          page: pageTitle,
        });
        componentTitle = null;
      }
    }
  }
}
console.error(`extracted ${entries.length} fens`);

// dedupe + validate
const seen = new Set();
const valid = [];
for (const e of entries) {
  if (seen.has(e.fen)) continue;
  seen.add(e.fen);
  if (!validateFen(e.fen).ok) continue;
  const c = new Chess(e.fen);
  if (c.isGameOver()) continue; // nothing to play
  valid.push(e);
}
console.error(`${valid.length} unique valid playable fens`);

// classify with native stockfish
const sf = spawn('/usr/games/stockfish');
let buf = '';
const lines = [];
let wake = null;
sf.stdout.on('data', (d) => {
  buf += d;
  const parts = buf.split('\n');
  buf = parts.pop();
  lines.push(...parts);
  if (wake) wake();
});
const waitFor = (re) =>
  new Promise((resolve) => {
    const check = () => {
      while (lines.length) {
        const m = lines.shift().match(re);
        if (m) { wake = null; return resolve(m); }
      }
      wake = check;
    };
    check();
  });

(async () => {
  sf.stdin.write('uci\n');
  await waitFor(/^uciok/);
  sf.stdin.write('setoption name Threads value 4\nsetoption name Hash value 256\n');

  const out = [];
  let done = 0;
  for (const e of valid) {
    sf.stdin.write(`position fen ${e.fen}\ngo movetime 250\n`);
    let last = null;
    // capture the last info line's score before bestmove
    while (true) {
      const m = await waitFor(/^(info .* score (cp|mate) (-?\d+).*|bestmove .*)$/);
      if (m[1].startsWith('bestmove')) break;
      last = { kind: m[2], val: Number(m[3]) };
    }
    done++;
    if (done % 50 === 0) console.error(`evaluated ${done}/${valid.length}`);
    if (!last) continue;
    const stm = e.fen.split(' ')[1]; // side to move
    const other = stm === 'w' ? 'b' : 'w';
    let goal, playerSide;
    if (last.kind === 'mate' || Math.abs(last.val) >= 200) {
      goal = 'win';
      playerSide = last.val > 0 ? stm : other; // player takes the winning side
    } else if (Math.abs(last.val) <= 50) {
      goal = 'draw';
      playerSide = stm; // defend from the side to move
    } else {
      continue; // ambiguous eval: not a clean training goal
    }
    out.push({ fen: e.fen, name: e.name, category: e.category, goal, playerSide });
  }
  sf.stdin.write('quit\n');

  // group into categories, stable order
  out.sort((a, b) => a.category.localeCompare(b.category));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const wins = out.filter((p) => p.goal === 'win').length;
  console.error(`wrote ${out.length} positions (${wins} win goals, ${out.length - wins} draw goals) to ${OUT}`);
})();
