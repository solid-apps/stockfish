import { Chessground } from './vendor/chessground.min.js';
import { Chess } from './vendor/chess.js';

// --- Engine (UCI over web worker) -----------------------------------------

class Engine {
  constructor(url) {
    this.worker = new Worker(url);
    this.listeners = [];
    this.queue = Promise.resolve(); // serializes searches (game moves vs hints)
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      this.listeners = this.listeners.filter((fn) => !fn(line));
    };
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  // Resolves when a line matching `re` arrives; listener returns true to detach.
  wait(re) {
    return new Promise((resolve) => {
      this.listeners.push((line) => {
        const m = line.match(re);
        if (m) resolve(m);
        return !!m;
      });
    });
  }

  // Observe every line until the returned detach function is called.
  listen(fn) {
    let active = true;
    this.listeners.push((line) => {
      if (!active) return true; // lazily removed
      fn(line);
      return false;
    });
    return () => { active = false; };
  }

  async init() {
    const ready = this.wait(/^uciok$/);
    this.send('uci');
    await ready;
    this.send('setoption name UCI_LimitStrength value true');
  }

  setElo(elo) {
    this.send(`setoption name UCI_Elo value ${elo}`);
  }

  newGame() {
    this.send('stop');
    this.send('ucinewgame');
  }

  // full=true searches at full strength (hints, evals).
  // pvs>1 also collects the engine's top-N candidate moves (MultiPV).
  // Returns {move, score, lines} — score is {kind: 'cp'|'mate', val} from the
  // side-to-move's point of view, from the deepest info line seen; lines[i]
  // is {move, score} for the (i+1)-th best candidate when pvs > 1.
  search(fen, movetimeMs, { full = false, pvs = 1 } = {}) {
    const run = async () => {
      this.send(`setoption name UCI_LimitStrength value ${full ? 'false' : 'true'}`);
      if (pvs > 1) this.send(`setoption name MultiPV value ${pvs}`);
      let score = null;
      const lines = [];
      const detach = this.listen((line) => {
        const pv = line.match(/^info .*\bmultipv (\d+) .*\bscore (cp|mate) (-?\d+).*\bpv (\S+)/);
        if (pv) {
          lines[Number(pv[1]) - 1] = { move: pv[4], score: { kind: pv[2], val: Number(pv[3]) } };
          return;
        }
        const m = line.match(/^info .*\bscore (cp|mate) (-?\d+)/);
        if (m) score = { kind: m[1], val: Number(m[2]) };
      });
      const done = this.wait(/^bestmove (\S+)/);
      this.send(`position fen ${fen}`);
      this.send(`go movetime ${movetimeMs}`);
      const move = (await done)[1];
      detach();
      if (pvs > 1) this.send('setoption name MultiPV value 1');
      return { move, score: lines[0] ? lines[0].score : score, lines };
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

// --- Game state -------------------------------------------------------------

const chess = new Chess();
const engine = new Engine('vendor/stockfish-18-lite-single.js');

let playerColor = 'white';
let thinking = false;
let searchId = 0; // bumped on new game to discard stale engine replies
let trainer = null; // active training position {fen, name, goal, playerSide}, or null
let positions = []; // loaded from positions.json

const statusEl = document.getElementById('status');
const movesEl = document.getElementById('moves');
const eloInput = document.getElementById('elo');
const eloLabel = document.getElementById('elo-label');
const colorSelect = document.getElementById('color-select');
const undoBtn = document.getElementById('undo');
const hintBtn = document.getElementById('hint');
const promoOverlay = document.getElementById('promo-overlay');
const trainerSelect = document.getElementById('trainer-select');
const evalFill = document.getElementById('eval-white');
const evalNum = document.getElementById('eval-num');
const pgnInput = document.getElementById('pgn-input');
const analysisEl = document.getElementById('analysis');
const graphEl = document.getElementById('graph');
const summaryEl = document.getElementById('analysis-summary');

// --- Eval bar -----------------------------------------------------------------

// score: {kind, val} from `stm`'s ('w'|'b') point of view
function setEval(score, stm) {
  if (!score) return;
  const sign = stm === 'w' ? 1 : -1;
  let frac, label;
  if (score.kind === 'mate') {
    const mate = sign * score.val;
    frac = mate > 0 ? 1 : 0;
    label = `#${Math.abs(score.val)}`;
  } else {
    const cp = sign * score.val;
    // cp -> win probability, same shape lichess uses
    frac = 1 / (1 + Math.exp(-0.00368208 * cp));
    label = (cp >= 0 ? '+' : '−') + Math.abs(cp / 100).toFixed(1);
  }
  evalFill.style.height = `${(frac * 100).toFixed(1)}%`;
  evalNum.textContent = label;
}

function setEvalTerminal() {
  if (chess.isCheckmate()) {
    const whiteWon = chess.turn() === 'b';
    evalFill.style.height = whiteWon ? '100%' : '0%';
    evalNum.textContent = whiteWon ? '1-0' : '0-1';
  } else {
    evalFill.style.height = '50%';
    evalNum.textContent = '½';
  }
}

// quick full-strength eval of the current position (start of games/puzzles)
async function evalCurrent() {
  const fenAtRequest = chess.fen();
  const { score } = await engine.search(fenAtRequest, 300, { full: true });
  if (chess.fen() === fenAtRequest && !chess.isGameOver()) {
    setEval(score, fenAtRequest.split(' ')[1]);
  }
}

// --- Post-game analysis graph -------------------------------------------------

const GRAPH_W = 560;
const GRAPH_H = 90;

// lichess-style judgements by win-probability lost on the move
const JUDGEMENTS = [
  { min: 0.3, kind: 'blunder', plural: 'blunders', glyph: '??', color: '#df5353' },
  { min: 0.2, kind: 'mistake', plural: 'mistakes', glyph: '?', color: '#e69f00' },
  { min: 0.1, kind: 'inaccuracy', plural: 'inaccuracies', glyph: '?!', color: '#56b4e9' },
];

let analysis = null; // {fens, moves, fracs, labels, marks, viewPly} while reviewing

// win probability 0..1 for the side to move (same sigmoid as the eval bar)
function moverWinFrac(score) {
  if (score.kind === 'mate') return score.val > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.00368208 * score.val));
}

// same, from White's point of view
function whiteWinFrac(score, stm) {
  return stm === 'w' ? moverWinFrac(score) : 1 - moverWinFrac(score);
}

function scoreLabel(score, stm) {
  const sign = stm === 'w' ? 1 : -1;
  if (score.kind === 'mate') return `#${Math.abs(score.val)}`;
  const cp = sign * score.val;
  return (cp >= 0 ? '+' : '−') + Math.abs(cp / 100).toFixed(1);
}

async function analyseGame() {
  if (analysis) return; // already reviewing this game
  const moves = chess.history({ verbose: true });
  if (moves.length < 2) return;
  const id = searchId;
  const a = analysis = {
    fens: [moves[0].before, ...moves.map((m) => m.after)],
    moves,
    fracs: [],
    labels: [],
    marks: [],
    viewPly: moves.length,
  };
  analysisEl.classList.remove('hidden');
  const finished = chess.isGameOver();
  for (let i = 0; i < a.fens.length; i++) {
    summaryEl.textContent = `Analysing… ${i + 1}/${a.fens.length}`;
    // a finished game's last position carries the real result (incl.
    // repetition draws the engine can't see from a lone FEN); everything
    // else is engine-evaluated
    const pos = finished && i === a.fens.length - 1 ? chess : new Chess(a.fens[i]);
    if (pos.isCheckmate()) {
      a.fracs.push(pos.turn() === 'w' ? 0 : 1);
      a.labels.push(pos.turn() === 'w' ? '0-1' : '1-0');
    } else if (pos.isGameOver()) {
      a.fracs.push(0.5);
      a.labels.push('½');
    } else {
      const { score } = await engine.search(a.fens[i], 180, { full: true });
      // a new game started or play continued — abandon the review
      if (id !== searchId || analysis !== a) return;
      const stm = a.fens[i].split(' ')[1];
      a.fracs.push(score ? whiteWinFrac(score, stm) : 0.5);
      a.labels.push(score ? scoreLabel(score, stm) : '?');
    }
    drawGraph();
  }
  a.marks = a.moves.map((m, i) => {
    const loss = m.color === 'w'
      ? a.fracs[i] - a.fracs[i + 1]
      : a.fracs[i + 1] - a.fracs[i];
    return JUDGEMENTS.find((j) => loss >= j.min) || null;
  });
  drawGraph();
  renderSummary();
  setBarFromAnalysis(a.viewPly);
}

function moveLabel(i) {
  const m = analysis.moves[i];
  const num = m.before.split(' ')[5];
  return `${num}${m.color === 'w' ? '.' : '…'} ${m.san}`;
}

function drawGraph() {
  if (!analysis) return;
  const n = analysis.fens.length - 1;
  const px = (i) => ((i / n) * GRAPH_W).toFixed(1);
  const py = (f) => ((1 - f) * GRAPH_H).toFixed(1);
  const parts = [];
  // white's share of win probability, filled from the bottom like the eval bar
  if (analysis.fracs.length > 1) {
    const pts = analysis.fracs.map((f, i) => `${px(i)} ${py(f)}`);
    parts.push(`<path d="M 0 ${GRAPH_H} L ${pts.join(' L ')} L ${px(analysis.fracs.length - 1)} ${GRAPH_H} Z" fill="#f5f3f0"/>`);
  }
  parts.push(`<line x1="0" y1="${GRAPH_H / 2}" x2="${GRAPH_W}" y2="${GRAPH_H / 2}" stroke="rgba(128,128,128,0.55)" stroke-dasharray="3 3"/>`);
  parts.push(`<line x1="${px(analysis.viewPly)}" y1="0" x2="${px(analysis.viewPly)}" y2="${GRAPH_H}" stroke="#629924" stroke-width="1.5"/>`);
  analysis.marks.forEach((mark, i) => {
    if (!mark) return;
    parts.push(`<circle cx="${px(i + 1)}" cy="${py(analysis.fracs[i + 1])}" r="3.5" fill="${mark.color}" stroke="#403d39"><title>${moveLabel(i)}${mark.glyph} (${mark.kind})</title></circle>`);
  });
  graphEl.innerHTML = parts.join('');
}

function renderSummary() {
  const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  for (const m of analysis.marks) if (m) counts[m.kind]++;
  summaryEl.innerHTML = JUDGEMENTS
    .map((j) => `<b style="color:${j.color}">${counts[j.kind]}</b> ${counts[j.kind] === 1 ? j.kind : j.plural}`)
    .join(' · ') + ' — click the graph or use ←/→ to review';
}

// show a past position on the board without touching game state
function gotoPly(ply) {
  if (!analysis) return;
  analysis.viewPly = ply;
  const pos = new Chess(analysis.fens[ply]);
  const mv = ply > 0 ? analysis.moves[ply - 1] : null;
  // at the final ply of an unfinished (loaded) game, play can continue
  const atLiveEnd = ply === analysis.fens.length - 1 && !chess.isGameOver();
  ground.set({
    fen: analysis.fens[ply],
    turnColor: fullColor(pos.turn()),
    check: pos.inCheck(),
    lastMove: mv ? [mv.from, mv.to] : undefined,
    movable: atLiveEnd ? { color: playerColor, dests: toDests() } : { color: undefined },
  });
  setBarFromAnalysis(ply);
  drawGraph();
}

function setBarFromAnalysis(ply) {
  if (analysis.fracs[ply] == null) return;
  evalFill.style.height = `${(analysis.fracs[ply] * 100).toFixed(1)}%`;
  evalNum.textContent = analysis.labels[ply];
}

function clearAnalysis() {
  analysis = null;
  analysisEl.classList.add('hidden');
  graphEl.innerHTML = '';
  summaryEl.textContent = '';
}

graphEl.addEventListener('click', (e) => {
  if (!analysis) return;
  const rect = graphEl.getBoundingClientRect();
  const n = analysis.fens.length - 1;
  const ply = Math.round(((e.clientX - rect.left) / rect.width) * n);
  gotoPly(Math.min(Math.max(ply, 0), n));
});

document.addEventListener('keydown', (e) => {
  if (!analysis) return;
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') gotoPly(Math.max(0, analysis.viewPly - 1));
  else if (e.key === 'ArrowRight') gotoPly(Math.min(analysis.fens.length - 1, analysis.viewPly + 1));
  else return;
  e.preventDefault();
});

// --- Sounds (lichess standard set) -------------------------------------------

const sounds = {
  move: new Audio('sounds/Move.mp3'),
  capture: new Audio('sounds/Capture.mp3'),
  gameEnd: new Audio('sounds/GenericNotify.mp3'),
};
let muted = localStorage.getItem('muted') === '1';

function playSound(name) {
  if (muted) return;
  const a = sounds[name];
  a.currentTime = 0;
  a.play().catch(() => {}); // autoplay may be blocked before first gesture
}

function soundForMove(move) {
  playSound(move.captured ? 'capture' : 'move');
  if (chess.isGameOver()) playSound('gameEnd');
}

const ground = Chessground(document.getElementById('board'), {
  fen: chess.fen(),
  orientation: playerColor,
  movable: {
    color: playerColor,
    free: false,
    dests: toDests(),
    showDests: true,
    events: { after: onUserMove },
  },
  premovable: { enabled: true },
});

// --- Helpers ----------------------------------------------------------------

function fullColor(c) {
  return c === 'w' ? 'white' : 'black';
}

function toDests() {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    const arr = dests.get(m.from) || [];
    arr.push(m.to);
    dests.set(m.from, arr);
  }
  return dests;
}

function sync(lastMove) {
  ground.set({
    fen: chess.fen(),
    turnColor: fullColor(chess.turn()),
    check: chess.inCheck(),
    ...(lastMove ? { lastMove } : {}),
    movable: {
      color: !thinking && !chess.isGameOver() ? playerColor : undefined,
      dests: toDests(),
    },
  });
  renderMoves();
  renderStatus();
  if (chess.isGameOver()) {
    setEvalTerminal();
    if (!analysis) {
      updatePermalink(); // finished games are shareable straight from the URL bar
      analyseGame();
    }
  }
  undoBtn.disabled = thinking || chess.isGameOver() || chess.history().length < minHistoryForUndo;
}

function renderMoves() {
  const history = chess.history();
  movesEl.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    li.appendChild(num);
    for (const san of [history[i], history[i + 1]]) {
      if (!san) continue;
      const s = document.createElement('span');
      s.className = 'san';
      s.textContent = san;
      li.appendChild(s);
    }
    movesEl.appendChild(li);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
}

function trainerGoalText() {
  const side = playerColor === 'white' ? 'White' : 'Black';
  return trainer.goal === 'win' ? `convert the win as ${side}` : `hold the draw as ${side}`;
}

function renderStatus() {
  if (trainer && chess.isGameOver()) {
    const playerWon = chess.isCheckmate() && fullColor(chess.turn()) !== playerColor;
    const drawn = !chess.isCheckmate();
    const success = trainer.goal === 'win' ? playerWon : playerWon || drawn;
    statusEl.textContent = success
      ? `Success — you ${trainer.goal === 'win' ? 'converted the win' : 'held the draw'}!`
      : `Failed — the goal was to ${trainerGoalText()}. "New game" retries it.`;
    return;
  }
  if (chess.isCheckmate()) {
    const winner = fullColor(chess.turn()) === playerColor ? 'Stockfish wins' : 'You win';
    statusEl.textContent = `Checkmate — ${winner}!`;
  } else if (chess.isStalemate()) {
    statusEl.textContent = 'Draw — stalemate.';
  } else if (chess.isThreefoldRepetition()) {
    statusEl.textContent = 'Draw — threefold repetition.';
  } else if (chess.isInsufficientMaterial()) {
    statusEl.textContent = 'Draw — insufficient material.';
  } else if (chess.isDraw()) {
    statusEl.textContent = 'Draw.';
  } else if (thinking) {
    statusEl.textContent = 'Stockfish is thinking…';
  } else {
    const move = chess.inCheck() ? 'Your move — check!' : 'Your move.';
    statusEl.textContent = trainer ? `Goal: ${trainerGoalText()}. ${move}` : move;
  }
}

// --- Moves ------------------------------------------------------------------

function onUserMove(orig, dest) {
  const piece = chess.get(orig);
  const lastRank = piece && piece.color === 'w' ? '8' : '1';
  if (piece && piece.type === 'p' && dest[1] === lastRank) {
    askPromotion().then((promotion) => {
      if (promotion) applyUserMove(orig, dest, promotion);
      else sync(); // cancelled: snap the board back
    });
    return;
  }
  applyUserMove(orig, dest);
}

// SAN for a uci move in the current position (for hint text)
function sanFor(uci) {
  const c = new Chess(chess.fen());
  return c.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  }).san;
}

async function hint() {
  if (thinking || chess.isGameOver()) return;
  hintBtn.disabled = true;
  hintBtn.textContent = 'Thinking…';
  const fenAtRequest = chess.fen();
  // MultiPV halves effective depth, so give the hint search more time
  const { score, lines } = await engine.search(fenAtRequest, 1000, { full: true, pvs: 2 });
  hintBtn.disabled = false;
  hintBtn.textContent = 'Get a hint';
  if (chess.fen() !== fenAtRequest) return; // position changed meanwhile
  const stm = fenAtRequest.split(' ')[1];
  setEval(score, stm);
  const [best, second] = lines;
  if (!best) return;
  const arrow = (l, brush) => ({
    orig: l.move.slice(0, 2),
    dest: l.move.slice(2, 4),
    brush,
    label: { text: scoreLabel(l.score, stm) },
  });
  const shapes = [arrow(best, 'green')];
  let secondNote = '';
  if (second) {
    // grade the runner-up by win probability given away, in the same
    // colour language as the analysis graph
    const gap = moverWinFrac(best.score) - moverWinFrac(second.score);
    const brush = gap < 0.05 ? 'blue' : gap < 0.15 ? 'yellow' : 'red';
    shapes.push(arrow(second, brush));
    secondNote = ` · 2nd: ${sanFor(second.move)} ${scoreLabel(second.score, stm)} (${Math.round(gap * 100)}% worse)`;
  }
  ground.setAutoShapes(shapes);
  statusEl.textContent = `Best: ${sanFor(best.move)} ${scoreLabel(best.score, stm)}${secondNote}`;
}

function applyUserMove(orig, dest, promotion) {
  let move;
  try {
    move = chess.move({ from: orig, to: dest, promotion });
  } catch {
    sync(); // illegal (e.g. bad premove): snap back
    return;
  }
  ground.setAutoShapes([]);
  if (analysis) clearAnalysis(); // continuing a loaded game ends its review
  soundForMove(move);
  sync([orig, dest]);
  if (!chess.isGameOver()) engineMove();
}

async function engineMove() {
  thinking = true;
  sync();
  const id = searchId;
  const fenAtSearch = chess.fen();
  // trainer positions are defended at full strength — that's the exercise
  const { move: uci, score } = await engine.search(fenAtSearch, 800, { full: !!trainer });
  if (id !== searchId) return; // a new game started meanwhile
  thinking = false;
  setEval(score, fenAtSearch.split(' ')[1]);
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined,
  });
  soundForMove(move);
  sync([move.from, move.to]);
  ground.playPremove();
}

function askPromotion() {
  promoOverlay.classList.remove('hidden');
  return new Promise((resolve) => {
    const done = (value) => {
      promoOverlay.classList.add('hidden');
      promoOverlay.onclick = null;
      resolve(value);
    };
    promoOverlay.onclick = (e) => {
      const btn = e.target.closest('button[data-piece]');
      done(btn ? btn.dataset.piece : null);
    };
  });
}

// --- Sharing games as ?pgn= links ---------------------------------------------

// PGN for the current game with the boilerplate seven-tag roster stripped;
// SetUp/FEN headers are kept so games from custom positions round-trip
function gamePgn() {
  return chess.pgn()
    .split('\n')
    .filter((l) => !/^\[(?!SetUp|FEN)/.test(l))
    .join('\n')
    .trim();
}

function updatePermalink() {
  history.replaceState(null, '', `?pgn=${encodeURIComponent(gamePgn())}`);
}

// Replace the current game with a pasted/linked one and review it.
// Returns false (leaving the app untouched) if the PGN doesn't parse.
function loadGameFromPgn(text) {
  const loaded = new Chess();
  try {
    loaded.loadPgn(text.trim());
  } catch {
    return false;
  }
  if (loaded.history().length < 2) return false;
  trainer = null;
  trainerSelect.value = '';
  searchId++;
  thinking = false;
  clearAnalysis();
  engine.newGame();
  engine.setElo(Number(eloInput.value));
  chess.loadPgn(loaded.pgn());
  playerColor = fullColor(chess.turn()); // if unfinished, you continue as the side to move
  ground.set({ orientation: playerColor });
  ground.cancelPremove();
  ground.setAutoShapes([]);
  minHistoryForUndo = chess.history().length + 2; // undo only moves made after loading
  const last = chess.history({ verbose: true }).at(-1);
  sync([last.from, last.to]);
  updatePermalink();
  analyseGame(); // review even when the game isn't finished
  return true;
}

pgnInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (loadGameFromPgn(pgnInput.value)) {
    pgnInput.value = '';
    pgnInput.blur();
  } else {
    pgnInput.classList.add('invalid');
    setTimeout(() => pgnInput.classList.remove('invalid'), 800);
  }
});

// --- Controls ---------------------------------------------------------------

let minHistoryForUndo = 2; // +1 when the engine moved first in this game

function startFreePlay() {
  trainer = null;
  trainerSelect.value = '';
  chess.reset();
  const choice = colorSelect.value;
  playerColor = choice === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : choice;
  begin();
}

function startTrainer(p) {
  trainer = p;
  chess.load(p.fen);
  playerColor = fullColor(p.playerSide);
  begin();
}

function begin() {
  searchId++;
  thinking = false;
  clearAnalysis();
  history.replaceState(null, '', location.pathname); // fresh game, fresh URL
  engine.newGame();
  engine.setElo(Number(eloInput.value));
  ground.set({ orientation: playerColor, lastMove: undefined });
  ground.cancelPremove();
  ground.setAutoShapes([]);
  const engineFirst = fullColor(chess.turn()) !== playerColor;
  minHistoryForUndo = (engineFirst ? 1 : 0) + 2;
  sync();
  if (engineFirst) engineMove();
  else evalCurrent();
}

// in trainer mode "New game" retries the current position
function newGame() {
  if (trainer) startTrainer(trainer);
  else startFreePlay();
}

async function loadPositions() {
  try {
    positions = await (await fetch('positions.json')).json();
  } catch {
    return; // trainer unavailable; free play still works
  }
  const groups = new Map();
  positions.forEach((p, i) => {
    let g = groups.get(p.category);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = p.category;
      trainerSelect.appendChild(g);
      groups.set(p.category, g);
    }
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${p.name} (${p.goal})`;
    g.appendChild(o);
  });
}

trainerSelect.addEventListener('change', () => {
  if (trainerSelect.value === '') startFreePlay();
  else startTrainer(positions[Number(trainerSelect.value)]);
});

function undo() {
  if (thinking || chess.turn() !== playerColor[0]) return;
  chess.undo(); // engine's reply
  chess.undo(); // player's move
  const last = chess.history({ verbose: true }).at(-1);
  sync(last ? [last.from, last.to] : undefined);
  evalCurrent();
}

const muteBtn = document.getElementById('mute');
muteBtn.textContent = muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('muted', muted ? '1' : '0');
  muteBtn.textContent = muted ? '🔇' : '🔊';
});

document.getElementById('new-game').addEventListener('click', newGame);
document.getElementById('flip').addEventListener('click', () => ground.toggleOrientation());
undoBtn.addEventListener('click', undo);
hintBtn.addEventListener('click', hint);
eloInput.addEventListener('input', () => {
  eloLabel.textContent = eloInput.value;
  engine.setElo(Number(eloInput.value));
});

// --- Boot -------------------------------------------------------------------

statusEl.textContent = 'Loading engine…';
loadPositions(); // in parallel with engine init
await engine.init();
const linkedPgn = new URLSearchParams(location.search).get('pgn');
if (!linkedPgn || !loadGameFromPgn(linkedPgn)) newGame();

// Console/debug handle
window.game = { chess, engine, move: applyUserMove, newGame, sounds, hint, startTrainer, gotoPly, loadGame: loadGameFromPgn };
